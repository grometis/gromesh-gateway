#!/usr/bin/env python3
"""Linux disposable VM operations, streamed over pinned SSH by host-events.mjs. Never run on a kind container."""
import base64
import json
import os
import re
import signal
import subprocess
import sys
import time


def clock():
    return dict(boot=open('/proc/sys/kernel/random/boot_id').read().strip(),
                machine=open('/etc/machine-id').read().strip(),
                wall=time.time() * 1000, mono=time.clock_gettime(time.CLOCK_BOOTTIME) * 1000,
                uptime=time.clock_gettime(time.CLOCK_BOOTTIME) * 1000,
                kernel=os.uname().release, node=os.uname().nodename)


def call(*args):
    return subprocess.check_output(args, text=True).strip()


def main(action, data):
    # systemd-detect-virt returns nonzero for bare metal. Containers share a kernel and cannot exercise this gate.
    virt = subprocess.run(['systemd-detect-virt', '--container'], capture_output=True, text=True)
    if virt.returncode == 0 or os.path.exists('/.dockerenv'):
        raise RuntimeError('a VM/bare-metal node with an independent kernel is required')
    if data.get('machine') and clock()['machine'] != data['machine']:
        raise RuntimeError('machine-id differs from the reviewed manifest')
    if action == 'clock':
        return clock()
    if action == 'signal':
        cid = data['container']
        if not re.fullmatch('[a-f0-9]{64}', cid):
            raise ValueError('invalid CRI container id')
        pid = json.loads(call('crictl', 'inspect', cid))['info']['pid']
        if open('/proc/%s/comm' % pid).read().strip() != 'isolation-probe':
            raise RuntimeError('only the selected isolation-probe may be signalled')
        os.kill(int(pid), {'STOP': signal.SIGSTOP, 'CONT': signal.SIGCONT}[data['signal']])
        return dict(clock(), pid=pid, container=cid)
    if action == 'state':
        uid = data['uid']
        if not re.fullmatch('[a-f0-9-]{36}', uid):
            raise ValueError('bad pod UID')
        directory = '/var/lib/kubelet/pods/%s/volumes/kubernetes.io~empty-dir/isolation' % uid
        with open(directory + '/probe-state.json') as stream:
            state = json.load(stream)
        try:
            with open(directory + '/lease.json') as stream:
                lease = json.load(stream)
        except FileNotFoundError:
            lease = None
        # No JWS, private key or nonce leaves the host.
        observed = clock()
        valid = bool(lease and lease.get('state') in ('ok', 'inconclusive') and
                     lease.get('bootId') == observed['boot'] and lease.get('podUid') == uid and
                     lease.get('admissionId') == state.get('admissionId') and
                     lease.get('expiresBoottimeNs', 0) / 1e6 > observed['mono'])
        return dict(observed, admission=state.get('admissionId'), seq=state.get('chain', {}).get('seq'),
                    proven=len(state.get('proven', [])), ready=state.get('state') == 'ok' and valid,
                    expires=lease.get('expiresBoottimeNs', 0) / 1e6 if valid else None)
    if action == 'reboot':
        before = clock()
        # A timer allows the caller to receive the acknowledgement before SSH drops.
        call('systemd-run', '--unit=gromesh-n2-reboot-' + data['run'], '--on-active=3s', 'systemctl', 'reboot')
        return before
    if action == 'rollback':
        before = clock()
        ntp = call('timedatectl', 'show', '-p', 'NTP', '--value') == 'yes'
        unit = 'gromesh-n2-clock-' + data['run']
        # Independent restoration survives a killed observer/SSH connection. Restore using BOOTTIME, never a stale
        # absolute date. Missing CAP_SYS_TIME must never prevent restoring the original NTP state.
        restore = ('import subprocess,time\n'
                   'try:\n'
                   '    time.clock_settime(time.CLOCK_REALTIME, %r + time.clock_gettime(time.CLOCK_BOOTTIME) - %r)\n'
                   'finally:\n'
                   '    subprocess.run(["timedatectl","set-ntp",%r],check=True)\n' %
                   (before['wall'] / 1000, before['mono'] / 1000, 'true' if ntp else 'false'))
        call('systemd-run', '--unit=' + unit, '--on-active=55s', 'python3', '-c', restore)
        # Verify that the watchdog actually exists before changing the host clock.
        call('systemctl', 'is-active', unit + '.timer')
        try:
            call('timedatectl', 'set-ntp', 'false')
            time.clock_settime(time.CLOCK_REALTIME, time.time() - 120)
        except BaseException:
            try:
                subprocess.run(['systemctl', 'start', unit + '.service'], check=True)
            finally:
                # The service may itself fail to start; recovery cannot rely on systemd alone.
                call('timedatectl', 'set-ntp', 'true' if ntp else 'false')
            raise
        return dict(before=before, after=clock(), restoreUnit=unit, ntp=ntp)
    if action == 'restore':
        unit = data['unit']
        if not re.fullmatch('gromesh-n2-clock-[a-f0-9]{16}', unit):
            raise ValueError('unexpected restore unit')
        # Idempotent even after the safety timer already ran and systemd garbage-collected its unit.
        before = data['before']
        try:
            time.clock_settime(time.CLOCK_REALTIME, before['wall'] / 1000 + time.clock_gettime(time.CLOCK_BOOTTIME) - before['mono'] / 1000)
        finally:
            call('timedatectl', 'set-ntp', 'true' if data['ntp'] else 'false')
        subprocess.run(['systemctl', 'stop', unit + '.timer'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        restored = clock()
        expected = before['wall'] + restored['mono'] - before['mono']
        if abs(restored['wall'] - expected) > 1000:
            raise RuntimeError('restored realtime does not match the monotonic baseline')
        restored['ntp'] = call('timedatectl', 'show', '-p', 'NTP', '--value') == 'yes'
        if restored['ntp'] != data['ntp']:
            raise RuntimeError('NTP did not return to its original state')
        return restored
    raise ValueError('unknown action')


if __name__ == '__main__':
    payload = json.loads(base64.b64decode(sys.argv[2]))
    print(json.dumps(main(sys.argv[1], payload)))
