"""Guarded stage-two installation on newly authorized Scaleway hosts. No provisioning API."""
import hashlib,json,os,platform,posixpath,re,shutil,socket,stat,subprocess,sys,tarfile,tempfile,time,urllib.request,uuid
from pathlib import Path,PurePosixPath
BASE=Path('/etc/gromesh-j8')

def native_architecture(machine):
 if machine not in ['x86_64','aarch64']:raise ValueError('native Linux architecture refused')
 return {'x86_64':'amd64','aarch64':'arm64'}[machine]

def validate_authorization(a,f,now):
 fields=['generation','hostname','machineIdHash','bootId','role','volumeId']
 if a.get('schema')!='gromesh-install-authorization/v1' or a.get('approved') is not True or a.get('fileUid')!=0 or a.get('fileMode',0)&0o077 or f.get('os')!='linux' or f.get('uid')!=0 or any(a.get(k)!=f.get(k) for k in fields) or not re.fullmatch(r'gromesh-j8-[a-z0-9]{8,24}',a.get('generation','')) or 'n2' in f.get('hostname','').lower() or not f.get('hostname','').startswith(a['generation']+'-'):
  raise ValueError('root authorization identity refused')
 if not isinstance(a.get('issuedAt'),(int,float)) or not isinstance(a.get('expiresAt'),(int,float)) or not a['issuedAt']<=now<a['expiresAt'] or not 0<a['expiresAt']-a['issuedAt']<=3600:raise ValueError('authorization expiry refused')
 return {'workerQualified':False}

def validate_volume(volume_id,f,minimum_gb=216):
 if not re.fullmatch(r'[a-f0-9-]{36}',volume_id) or f.get('serial')!='volume-'+volume_id or f.get('vendor','').strip()!='SCW' or f.get('model','').strip()!='sbs' or f.get('type')!='disk' or f.get('root') is not False or f.get('children') is not False or f.get('filesystem') is not None or f.get('mounted') is not False or minimum_gb not in [35,216] or f.get('size',0)<minimum_gb*1000000000:raise ValueError('owned empty non-root volume refused')
 return True

def protected_parent(path):
 for p in [path,*path.parents]:
  s=p.lstat()
  if p.is_symlink() or s.st_uid!=os.getuid() or s.st_mode&0o022:raise ValueError('protected path refused')

def inventory(root):
 out={}
 for p in [root,*sorted(root.rglob('*'))]:
  s=p.lstat()
  if s.st_uid!=os.getuid() or (not p.is_symlink() and s.st_mode&0o022):raise ValueError('writable/foreign runtime refused')
  name=str(p.relative_to(root))
  if p.is_symlink():
   if not p.resolve().is_relative_to(root.resolve()) or not p.exists():raise ValueError('existing symlink escape refused')
   out[name]={'link':os.readlink(p)}
  elif p.is_file():out[name]={'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'mode':stat.S_IMODE(s.st_mode)}
  elif not p.is_dir():raise ValueError('special runtime file refused')
 return out

def install_archive(archive,dest,sha256,fmt,strip):
 archive=Path(archive);dest=Path(dest)
 actual_parent=dest.parent.resolve()
 fixture=any(p.name.startswith('gromesh-j8-fixture-') and p.parent.resolve()==Path(tempfile.gettempdir()).resolve() for p in [actual_parent,*actual_parent.parents])
 if not fixture and not (platform.system()=='Linux' and os.getuid()==0 and str(dest).startswith('/opt/gromesh/tools/')):raise ValueError('authorized destination refused')
 if dest.parent!=actual_parent or dest.is_symlink() or archive.is_symlink() or not re.fullmatch(r'[a-f0-9]{64}',sha256) or hashlib.sha256(archive.read_bytes()).hexdigest()!=sha256:raise ValueError('artifact checksum/path refused')
 if not dest.parent.exists():raise ValueError('protected destination parent required')
 if not fixture:protected_parent(dest.parent)
 expected={'sourceSha256':sha256,'format':fmt,'strip':strip}
 marker=dest/'.gromesh-inventory.json'
 if dest.exists():
  data=json.loads(marker.read_text());observed=inventory(dest);observed.pop('.gromesh-inventory.json',None)
  if data.get('artifact')!=expected or data.get('files')!=observed:raise ValueError('existing/partial runtime differs')
  return {'changed':False,'workerQualified':False}
 staging=dest.parent/('.gromesh-stage-'+uuid.uuid4().hex);staging.mkdir(mode=0o700);links=[]
 if fmt in ['tar.gz','tar.xz']:
  with tarfile.open(archive,'r:*') as source:
   total=0;seen=set();members=source.getmembers()
   if len(members)>50000:raise ValueError('archive member limit')
   for m in members:
    raw=PurePosixPath(m.name)
    if raw.is_absolute() or '..' in raw.parts:raise ValueError('archive escape refused')
    parts=raw.parts[strip:]
    if not parts:continue
    name='/'.join(parts)
    if name=='.gromesh-inventory.json' or name in seen:raise ValueError('duplicate archive member refused')
    seen.add(name);target=staging/name
    if any(p.is_symlink() for p in target.parents if p!=staging.parent):raise ValueError('archive symlink parent')
    if m.isdir():target.mkdir(parents=True,exist_ok=True);continue
    target.parent.mkdir(parents=True,exist_ok=True)
    if m.issym():
     to=posixpath.normpath(posixpath.join(posixpath.dirname(name),m.linkname))
     if m.linkname.startswith('/') or to=='..' or to.startswith('../'):raise ValueError('archive symlink escape')
     links.append((target,m.linkname,to));continue
    if not m.isfile() or m.size>200*2**20:raise ValueError('archive special/oversize refused')
    total+=m.size
    if total>1024**3:raise ValueError('archive size limit')
    with source.extractfile(m) as stream,target.open('xb') as out:shutil.copyfileobj(stream,out,1024*1024)
    target.chmod(0o555 if m.mode&0o111 else 0o444)
   for target,link,to in links:
    if not (staging/to).exists() or (staging/to).is_symlink():raise ValueError('unresolved archive link refused')
    target.symlink_to(link)
 elif fmt=='binary':
  shutil.copyfile(archive,staging/'binary');(staging/'binary').chmod(0o555)
 else:raise ValueError('archive format refused')
 for p in sorted(staging.rglob('*'),reverse=True):
  if p.is_dir() and not p.is_symlink():p.chmod(0o555)
 files=inventory(staging)
 marker=staging/'.gromesh-inventory.json';marker.write_text(json.dumps({'artifact':expected,'files':files},sort_keys=True)+'\n');marker.chmod(0o444);staging.chmod(0o555)
 staging.rename(dest);return {'changed':True,'workerQualified':False}

def run(args,timeout=600,env=None):
 return subprocess.run(args,text=True,check=True,capture_output=True,timeout=timeout,env=env).stdout

def private_json(path):
 p=Path(path);s=p.lstat()
 if p.is_symlink() or p.resolve()!=p or s.st_uid!=0 or s.st_mode&0o077 or s.st_size>65536:raise ValueError('private root-owned input refused')
 protected_parent(p.parent);return json.loads(p.read_text())|{'fileUid':s.st_uid,'fileMode':stat.S_IMODE(s.st_mode)}

def prepare_work_volume(c,a):
 volume_id=c['volumeId'].split('/')[-1];marker=Path('/opt/.gromesh-volume-generation.json')
 if marker.exists():
  if json.loads(marker.read_text())!={'generation':c['generation'],'volumeId':c['volumeId']}:raise ValueError('existing volume generation differs')
  if 'xfs' not in run(['/usr/bin/findmnt','-n','-o','FSTYPE','/opt']) or 'prjquota' not in run(['/usr/bin/findmnt','-n','-o','OPTIONS','/opt']):raise ValueError('project quota mount missing')
  return
 if a.get('initializeVolume') is not True or list(Path('/opt').iterdir()):raise ValueError('empty work mount and exact-ID initialization approval required')
 rows=json.loads(run(['/usr/bin/lsblk','--json','--bytes','-o','PATH,TYPE,SERIAL,VENDOR,MODEL,FSTYPE,MOUNTPOINTS,SIZE']))['blockdevices']
 matches=[d for d in rows if d.get('serial')=='volume-'+volume_id]
 if len(matches)!=1:raise ValueError('one exact volume required')
 d=matches[0];facts={'serial':d.get('serial'),'vendor':d.get('vendor'),'model':d.get('model'),'type':d.get('type'),'root':any('/' in (v.get('mountpoints') or []) for v in [d]+d.get('children',[])),'children':bool(d.get('children')),'filesystem':d.get('fstype'),'mounted':any(d.get('mountpoints') or []),'size':d['size']}
 validate_volume(volume_id,facts,35 if c['role']=='coordinator' else 216)
 if json.loads(run(['/usr/sbin/wipefs','--no-act','--json',d['path']])).get('signatures'):raise ValueError('existing signatures preserved')
 run(['/usr/sbin/mkfs.xfs','-L','gromesh-work',d['path']]);run(['/usr/bin/mount','-o','prjquota,nodev,nosuid',d['path'],'/opt'])
 fsuuid=run(['/usr/sbin/blkid','-s','UUID','-o','value',d['path']]).strip()
 with open('/etc/fstab','a') as f:f.write('UUID='+fsuuid+' /opt xfs defaults,prjquota,nodev,nosuid 0 2\n')
 # Project inheritance covers rootless subordinate IDs, unlike a simple UID quota.
 Path('/opt/executor').mkdir(mode=0o755)
 with open('/etc/projects','a') as f:f.write('1100:/opt/executor\n')
 with open('/etc/projid','a') as f:f.write('gromesh:1100\n')
 run(['/usr/sbin/xfs_quota','-x','-c','project -s gromesh','/opt']);run(['/usr/sbin/xfs_quota','-x','-c','limit -p '+('bsoft=7g bhard=8g' if c['role']=='coordinator' else 'bsoft=140g bhard=150g')+' gromesh','/opt'])
 marker.write_text(json.dumps({'generation':c['generation'],'volumeId':c['volumeId']}));marker.chmod(0o444)

def executor_mount_plan():
 return [{'source':'/opt/executor/'+name,'target':target,'mode':mode,'options':'bind,nodev,nosuid'} for name,target,mode in [('workspaces','/workspace',0o700),('tmp','/tmp',0o1777),('var-tmp','/var/tmp',0o1777),('crash','/var/crash',0o1777)]]

def boot_writable_paths(output,device):
 return [line.split(' ',1)[1] for line in output.splitlines() if line.split(' ',1)[0]==str(device)]

def prepare_executor_mounts(c):
 if platform.system()!='Linux' or os.getuid()!=0:raise ValueError('Linux root required')
 marker=Path('/opt/.gromesh-volume-generation.json')
 if marker.is_symlink() or json.loads(marker.read_text())!={'generation':c['generation'],'volumeId':c['volumeId']} or run(['/usr/bin/findmnt','-n','-o','FSTYPE','/opt']).strip()!='xfs' or 'prjquota' not in run(['/usr/bin/findmnt','-n','-o','OPTIONS','/opt']):raise ValueError('owned project quota mount required')
 fstab=Path('/etc/fstab');existing=fstab.read_text()
 for item in executor_mount_plan():
  source,target=Path(item['source']),Path(item['target'])
  if source.is_symlink() or target.is_symlink():raise ValueError('bind path symlink refused')
  source.mkdir(mode=item['mode'],exist_ok=True);target.mkdir(mode=0o755,exist_ok=True)
  # Temporary paths are host-global sticky directories, inside the same project quota.
  # Old boot-disk temporary contents are preserved underneath, never deleted/moved.
  if target.is_mount():
   if (source.stat().st_dev,source.stat().st_ino)!=(target.stat().st_dev,target.stat().st_ino):raise ValueError('foreign mount preserved')
  else:
   if item['target']=='/workspace' and list(target.iterdir()):raise ValueError('existing workspace preserved')
   run(['/usr/bin/mount','--bind','-o','nodev,nosuid',str(source),str(target)])
  source.chmod(item['mode']);os.chown(source,1100 if item['target']=='/workspace' else 0,1100 if item['target']=='/workspace' else 0)
  if (source.stat().st_dev,source.stat().st_ino)!=(target.stat().st_dev,target.stat().st_ino):raise ValueError('mount identity refused')
  entry=f"{source} {target} none {item['options']},x-systemd.requires-mounts-for=/opt 0 0\n"
  if entry not in existing:
   if any(len(line.split())>1 and line.split()[1]==str(target) for line in existing.splitlines() if not line.lstrip().startswith('#')):raise ValueError('existing fstab mount preserved')
   with fstab.open('a') as file:file.write(entry)
   existing+=entry
 # Refuse unexplained boot-filesystem paths writable by the future executor.
 # /run and /dev/shm are tmpfs and must remain memory/cgroup bounded in qualification.
 result=subprocess.run(['/usr/sbin/runuser','-u','gromesh-executor','--','/usr/bin/find','/','-xdev','-type','d','-writable','-printf','%D %p\n'],text=True,capture_output=True,timeout=120)
 if result.returncode not in [0,1] or boot_writable_paths(result.stdout,Path('/').stat().st_dev):raise ValueError('executor-writable boot directories require review')


def fetch_artifact(item,cache):
 url=item['url']
 if not url.startswith(('https://nodejs.org/','https://go.dev/','https://dl.google.com/go/','https://github.com/','https://registry.npmjs.org/','https://download.docker.com/','https://get.helm.sh/','https://dl.k8s.io/')):raise ValueError('official download required')
 target=cache/(item['name']+('.deb' if item['format']=='deb' else '.artifact'));digest=hashlib.sha256();size=0
 if target.exists():
  if hashlib.sha256(target.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('cached bytes differ')
  return target
 req=urllib.request.Request(url,headers={'User-Agent':'Gromesh-approved-host-bootstrap/1.0'})
 with urllib.request.urlopen(req,timeout=30) as src,target.open('xb') as out:
  while chunk:=src.read(1024*1024):
   size+=len(chunk)
   if size>200*2**20:raise ValueError('download bounded size exceeded')
   digest.update(chunk);out.write(chunk)
 if digest.hexdigest()!=item['sha256']:raise ValueError('download checksum refused')
 target.chmod(0o400);return target

def main():
 if platform.system()!='Linux' or os.getuid()!=0:raise ValueError('Linux root required')
 c=private_json('/etc/gromesh-j8/context.json');a=private_json('/etc/gromesh-j8/authorization.json')
 facts={**c,'os':'linux','uid':0,'machineIdHash':hashlib.sha256(Path('/etc/machine-id').read_bytes()).hexdigest(),'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'hostname':socket.gethostname()}
 validate_authorization(a,facts,time.time())
 if sys.argv[1:]==['--validate-only']:return
 native=native_architecture(platform.machine())
 if native!=c['architecture'] or not (BASE/'enrolled.json').exists():raise ValueError('native enrolled host required')
 prepare_work_volume(c,a)
 tools=Path('/opt/gromesh/tools');tools.mkdir(parents=True,exist_ok=True);protected_parent(tools)
 cache=BASE/'downloads';cache.mkdir(mode=0o700,exist_ok=True)
 lock=json.loads(Path('/usr/local/lib/gromesh-j8/tools.lock.json').read_text());items=lock['architectures'][native]
 selected=items if c['role']!='coordinator' else [x for x in items if x['name']=='node']
 for item in selected:
  file=fetch_artifact(item,cache)
  if item['format']!='deb':install_archive(file,tools/item['name'],item['sha256'],item['format'],item.get('strip',0))
 debs=[x for x in selected if x['format']=='deb']
 if debs:
  versions={}
  for item in debs:
   query=subprocess.run(['/usr/bin/dpkg-query','-W','-f=${Version}',item['name']],text=True,capture_output=True,timeout=20)
   versions[item['name']]=query.stdout.strip() if query.returncode==0 else None
  if any(versions.values()) and any(versions[x['name']]!=x['version'] for x in debs):raise ValueError('existing/partial Docker installation differs; preserve for review')
  if not any(versions.values()):run(['/usr/bin/apt-get','install','-y','--no-install-recommends',*[str(cache/(x['name']+'.deb')) for x in debs]],timeout=1200,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','DEBIAN_FRONTEND':'noninteractive'})
 # Activation is a separate gate: install_runtime/Rootless services/agent registration are not self-qualified.
 print(json.dumps({'status':'TOOLS_INSTALLED_RUNTIME_AND_ROOTLESS_QUALIFICATION_REQUIRED','workerQualified':False,'agentRegistered':False,'publicationEnabled':False,'applyEnabled':False}))
if __name__=='__main__':
 try:main()
 except Exception:
  print('GROMESH_HOST_BOOTSTRAP_REFUSED',file=sys.stderr);sys.exit(78)
