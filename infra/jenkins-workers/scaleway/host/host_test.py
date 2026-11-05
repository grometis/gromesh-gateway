import importlib.util,json,unittest,tempfile,tarfile,io,hashlib,os
from pathlib import Path

def load(name):
 spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
boot=load('bootstrap');enroll=load('enroll')
class HostTests(unittest.TestCase):
 def test_temporary_paths_share_project_quota_and_cannot_fill_boot(self):
  plan=boot.executor_mount_plan()
  self.assertEqual({p['target'] for p in plan},{'/workspace','/tmp','/var/tmp','/var/crash'})
  self.assertTrue(all(p['source'].startswith('/opt/executor/') for p in plan))
  self.assertTrue(all(p['options']=='bind,nodev,nosuid' for p in plan))
  self.assertTrue(all(p['mode']==0o1777 for p in plan if p['target']!='/workspace'))
  self.assertEqual(boot.boot_writable_paths('99 /tmp\n99 /workspace\n1 /var/unsafe\n',1),['/var/unsafe'])
 def test_native_kernel_architectures_are_normalized_and_emulation_is_refused(self):
  self.assertEqual(boot.native_architecture('x86_64'),'amd64')
  self.assertEqual(boot.native_architecture('aarch64'),'arm64')
  with self.assertRaises(ValueError):boot.native_architecture('i686')
 def test_authorization_is_exact_and_never_worker_qualification(self):
  a={'schema':'gromesh-install-authorization/v1','approved':True,'generation':'gromesh-j8-20261105a','hostname':'gromesh-j8-20261105a-pr-amd64','machineIdHash':'a'*64,'bootId':'boot-fixture','expiresAt':10000,'issuedAt':9000,'role':'pr-amd64','volumeId':'fr-par-2/11111111-1111-4111-8111-111111111111','fileUid':0,'fileMode':0o600}
  f={'os':'linux','uid':0,'hostname':a['hostname'],'generation':a['generation'],'machineIdHash':a['machineIdHash'],'bootId':a['bootId'],'role':a['role'],'volumeId':a['volumeId']}
  self.assertFalse(boot.validate_authorization(a,f,9500)['workerQualified'])
  for k,v in [('os','darwin'),('hostname','gromesh-n2-lab'),('volumeId','other'),('uid',1100),('bootId','other')]:
   with self.subTest(k=k),self.assertRaises(ValueError):boot.validate_authorization(a,{**f,k:v},9500)
  for changes in [{'expiresAt':9400},{'fileMode':0o666},{'fileUid':1100},{'approved':False}]:
   with self.assertRaises(ValueError):boot.validate_authorization({**a,**changes},f,9500)
 def test_volume_selection_requires_exact_scw_serial_and_nonroot_empty_disk(self):
  v='11111111-1111-4111-8111-111111111111';f={'serial':'volume-'+v,'vendor':'SCW','model':'sbs','type':'disk','root':False,'children':False,'filesystem':None,'mounted':False,'size':216000000000}
  self.assertTrue(boot.validate_volume(v,f))
  for k,v in [('serial','volume-other'),('root',True),('children',True),('filesystem','ext4'),('mounted',True),('size',1000000),('vendor','QEMU')]:
   with self.subTest(k=k),self.assertRaises(ValueError):boot.validate_volume('11111111-1111-4111-8111-111111111111',{**f,k:v})
 def test_real_archive_install_is_idempotent_and_preserves_unrelated_files(self):
  with tempfile.TemporaryDirectory(prefix='gromesh-j8-fixture-') as d:
   r=Path(d).resolve();archive=r/'tool.tar.gz'
   with tarfile.open(archive,'w:gz') as t:
    i=tarfile.TarInfo('tool/bin/check');b=b'fixture executable bytes';i.size=len(b);i.mode=0o755;t.addfile(i,io.BytesIO(b))
   digest=hashlib.sha256(archive.read_bytes()).hexdigest();dest=r/'installed';(r/'keep').write_text('keep')
   self.assertTrue(boot.install_archive(archive,dest,digest,'tar.gz',1)['changed']);self.assertFalse(boot.install_archive(archive,dest,digest,'tar.gz',1)['changed']);self.assertEqual((dest/'bin/check').read_bytes(),b);self.assertEqual((r/'keep').read_text(),'keep')
   (dest/'bin').chmod(0o777)
   with self.assertRaises(ValueError):boot.install_archive(archive,dest,digest,'tar.gz',1)
 def test_contained_tool_symlinks_survive_and_escaping_changes_are_refused(self):
  with tempfile.TemporaryDirectory(prefix='gromesh-j8-fixture-') as d:
   r=Path(d).resolve();a=r/'links.tgz'
   with tarfile.open(a,'w:gz') as t:
    f=tarfile.TarInfo('pkg/lib/tool.js');f.size=1;t.addfile(f,io.BytesIO(b'x'));link=tarfile.TarInfo('pkg/bin/tool');link.type=tarfile.SYMTYPE;link.linkname='../lib/tool.js';t.addfile(link)
   dest=r/'tool';digest=hashlib.sha256(a.read_bytes()).hexdigest();boot.install_archive(a,dest,digest,'tar.gz',1);self.assertEqual((dest/'bin/tool').read_bytes(),b'x');self.assertFalse(boot.install_archive(a,dest,digest,'tar.gz',1)['changed'])
 def test_archive_escape_symlink_and_checksum_refused(self):
  with tempfile.TemporaryDirectory(prefix='gromesh-j8-fixture-') as d:
   r=Path(d).resolve()
   for name,link in [('../escape',None),('root/link','../../escape'),('/etc/escape',None)]:
    a=r/'bad.tgz'
    with tarfile.open(a,'w:gz') as t:
     i=tarfile.TarInfo(name)
     if link:i.type=tarfile.SYMTYPE;i.linkname=link
     else:i.size=1
     t.addfile(i,None if link else io.BytesIO(b'x'))
    with self.assertRaises(ValueError):boot.install_archive(a,r/'bad',hashlib.sha256(a.read_bytes()).hexdigest(),'tar.gz',0)
   with self.assertRaises(ValueError):boot.install_archive(a,r/'bad','0'*64,'tar.gz',0)
 def test_peer_roles_allow_only_fixed_overlay_routes_and_public_keys(self):
  p={'role':'controller','allowedIp':'10.89.0.2/32','publicKey':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}
  self.assertEqual(enroll.validate_peers([p],'coordinator'),[p])
  for changes in [{'allowedIp':'0.0.0.0/0'},{'privateKey':'secret'},{'publicKey':'bad'},{'allowedIp':'192.168.15.3/32'}]:
   with self.assertRaises(ValueError):enroll.validate_peers([{**p,**changes}],'coordinator')
  with self.assertRaises(ValueError):enroll.validate_peers([p,p],'coordinator')
 def test_metadata_exception_is_root_only_and_removed_after_enrollment(self):
  c={'role':'pr-amd64','relayPublicIp':'203.0.113.20','operatorCidr':'203.0.113.10/32','workerPublicIps':['203.0.113.21','203.0.113.22']}
  before=enroll.firewall_rules(c,True);after=enroll.firewall_rules(c,False)
  self.assertIn('meta skuid 0 ip daddr 169.254.42.42 tcp dport 80 accept',before);self.assertNotIn('tcp dport 80 accept',after);self.assertIn('192.168.0.0/16',after);self.assertIn('policy drop',after);self.assertNotIn('tcp dport 22 accept',after.split('chain input')[0]);self.assertIn('ip saddr 10.89.0.2 tcp dport 22 accept',after)
 def test_client_relay_route_carries_controller_without_opening_private_networks(self):
  p={'role':'coordinator','allowedIp':'10.89.0.1/32','publicKey':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}
  text=enroll.public_peer_config([p],'pr-amd64','203.0.113.20');self.assertIn('10.89.0.1/32,10.89.0.2/32',text);self.assertNotIn('0.0.0.0/0',text)
if __name__=='__main__':unittest.main()
