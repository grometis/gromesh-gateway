"""Future-host public-key enrollment. Never returns or logs private keys. No cloud credentials."""
import base64,hashlib,ipaddress,json,os,re,socket,subprocess,sys,time,urllib.request
from pathlib import Path
ADDRESSES={'coordinator':'10.89.0.1/32','controller':'10.89.0.2/32','pr-amd64':'10.89.0.11/32','pr-arm64':'10.89.0.12/32'}
ROOT=Path('/etc/gromesh-j8')
def validate_peers(peers,role):
 if role not in ['coordinator','pr-amd64','pr-arm64'] or not isinstance(peers,list) or not 1<=len(peers)<=3:raise ValueError('peer count/role')
 seen=set();keys=set()
 for p in peers:
  if set(p)!={'role','allowedIp','publicKey'} or p['role']==role or p.get('allowedIp')!=ADDRESSES.get(p.get('role')) or not re.fullmatch(r'[A-Za-z0-9+/]{43}=',p.get('publicKey','')) or len(base64.b64decode(p['publicKey'],validate=True))!=32 or p['role'] in seen or p['publicKey'] in keys or role!='coordinator' and p['role']!='coordinator':raise ValueError('peer identity/key/route')
  seen.add(p['role']);keys.add(p['publicKey'])
 return peers

def public_peer_config(peers,role,relay_ip):
 validate_peers(peers,role);ipaddress.IPv4Address(relay_ip);lines=[]
 for p in peers:
  routes=p['allowedIp'] if role=='coordinator' else '10.89.0.1/32,10.89.0.2/32'
  lines+=['[Peer]','PublicKey = '+p['publicKey'],'AllowedIPs = '+routes]
  if role!='coordinator':lines+=['Endpoint = '+relay_ip+':51820','PersistentKeepalive = 25']
 return '\n'.join(lines)+'\n'

def firewall_rules(c,metadata):
 role=c['role'];relay=str(ipaddress.IPv4Address(c['relayPublicIp']));operator=str(ipaddress.IPv4Network(c['operatorCidr'],strict=True))
 workers=[str(ipaddress.IPv4Address(s)) for s in c['workerPublicIps']]
 if role not in ['coordinator','pr-amd64','pr-arm64'] or not operator.endswith('/32') or len(workers)!=2:raise ValueError('firewall identity')
 outer=', '.join([operator]+[s+'/32' for s in workers]) if role=='coordinator' else relay+'/32'
 ingress=f'ip saddr {{ {outer} }} udp dport 51820 accept' if role=='coordinator' else ''
 meta='meta skuid 0 ip daddr 169.254.42.42 tcp dport 80 accept' if metadata else ''
 forward='iifname "wg0" oifname "wg0" ip saddr 10.89.0.2 ip daddr {10.89.0.11,10.89.0.12} tcp dport 22 accept' if role=='coordinator' else ''
 return f'''table inet gromesh {{
 chain input {{ type filter hook input priority -10; policy drop;
  iifname "lo" accept
  ct state established,related accept
  {ingress}
  iifname "wg0" ip saddr 10.89.0.2 tcp dport 22 accept
  udp sport 67 udp dport 68 accept
 }}
 chain output {{ type filter hook output priority -10; policy drop;
  oifname "lo" accept
  ct state established,related accept
  {meta}
  ip daddr {{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10}} drop
  ip daddr 0.0.0.0/0 tcp dport 443 accept
  ip daddr {{1.1.1.1,9.9.9.9}} udp dport 53 accept
  ip daddr 0.0.0.0/0 udp dport 123 accept
  meta skuid 0 ip daddr {{ {outer} }} udp dport 51820 accept
  udp sport 68 udp dport 67 accept
 }}
 chain forward {{ type filter hook forward priority -10; policy drop;
  ct state established,related accept
  {forward}
 }}
}}\n'''

def run(args,input=None):
 return subprocess.run(args,input=input,text=True,check=True,capture_output=True,timeout=30).stdout

def context():
 p=ROOT/'context.json';s=p.lstat()
 if os.uname().sysname!='Linux' or os.getuid()!=0 or p.is_symlink() or s.st_uid!=0 or s.st_mode&0o077:raise ValueError('authorized root context')
 c=json.loads(p.read_text())
 if c.get('schema')!='gromesh-cloud-context/v1' or c.get('hostname')!=socket.gethostname() or not re.fullmatch(r'gromesh-j8-[a-z0-9]{8,24}',c.get('generation','')) or 'n2' in c['hostname'].lower():raise ValueError('wrong host')
 return c

def install_firewall(c,metadata):
 text=firewall_rules(c,metadata)
 exists=subprocess.run(['/usr/sbin/nft','list','table','inet','gromesh'],capture_output=True,timeout=10).returncode==0
 run(['/usr/sbin/nft','-f','-'],('delete table inet gromesh\n' if exists else '')+text)
 # A dedicated table only; never flush other rules or firewall ownership.
 (ROOT/'gromesh.nft').write_text(text);os.chmod(ROOT/'gromesh.nft',0o600)
 service=Path('/etc/systemd/system/gromesh-firewall.service')
 service.write_text('[Unit]\nBefore=network-pre.target\nWants=network-pre.target\nDefaultDependencies=no\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/sbin/nft -f /etc/gromesh-j8/gromesh.nft\n[Install]\nWantedBy=multi-user.target\n')
 run(['/usr/bin/systemctl','enable','gromesh-firewall.service'])

def main():
 c=context()
 if sys.argv[1:]==['--install-firewall']:
  run(['/usr/sbin/sysctl','-w','net.ipv6.conf.all.disable_ipv6=1']);install_firewall(c,True);return
 if (ROOT/'enrolled.json').exists():install_firewall(c,False);return
 key=Path('/etc/wireguard/gromesh.key');s=key.lstat()
 if key.is_symlink() or s.st_uid!=0 or s.st_mode&0o077:raise ValueError('private local key required')
 public=run(['/usr/bin/wg','pubkey'],key.read_text()).strip()
 host_pub=Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()[1]
 fingerprint='SHA256:'+base64.b64encode(hashlib.sha256(base64.b64decode(host_pub)).digest()).decode().rstrip('=')
 identity={'hostname':c['hostname'],'generation':c['generation'],'wireguardPublicKey':public,'sshHostPublicKey':host_pub,'sshFingerprint':fingerprint}
 (ROOT/'public-identity.json').write_text(json.dumps(identity)+'\n')
 # Public identity repeats to console output, before any Linux login. Never prints a private key.
 for _ in range(100):
  try:
   with open('/dev/console','w') as console:console.write('GROMESH_PUBLIC_IDENTITY '+json.dumps(identity)+'\n')
  except OSError:pass
  try:
   with urllib.request.urlopen('http://169.254.42.42/user_data/gromesh-enrollment',timeout=5) as response:data=response.read(16385)
   if len(data)>16384:raise ValueError('enrollment size')
   p=json.loads(data)
   if set(p)!={'schema','generation','hostname','peers'} or p['schema']!='gromesh-public-enrollment/v1' or p['generation']!=c['generation'] or p['hostname']!=c['hostname']:raise ValueError('enrollment binding')
   peers=validate_peers(p['peers'],c['role']);text=public_peer_config(peers,c['role'],c['relayPublicIp'])
   conf=Path('/etc/wireguard/wg0.conf')
   if conf.exists():raise ValueError('existing interface configuration requires review')
   text='[Interface]\nAddress = '+c['overlayIp']+'/32\nListenPort = 51820\nPrivateKey = '+key.read_text().strip()+'\n\n'+text
   conf.write_text(text);os.chmod(conf,0o600)
   run(['/usr/sbin/sysctl','-w','net.ipv4.ip_forward='+('1' if c['role']=='coordinator' else '0')])
   run(['/usr/bin/systemctl','enable','--now','wg-quick@wg0.service']);install_firewall(c,False)
   (ROOT/'enrolled.json').write_text(json.dumps({'generation':c['generation'],'metadataAccess':False,'workerQualified':False})+'\n');return
  except (OSError,ValueError,json.JSONDecodeError):time.sleep(20)
 raise ValueError('Enrollment window expired; no SSH fallback')

if __name__=='__main__':
 try:main()
 except Exception:
  print('GROMESH_ENROLLMENT_BLOCKED',file=sys.stderr);sys.exit(78)
