import copy,hashlib,importlib.util,json,os,subprocess,tempfile,unittest
from pathlib import Path
from persistent_job_extension import extension,NAMES
NODE=os.environ.get('GROMESH_NODE','node')
REPO=Path(__file__).resolve().parents[2]
class PersistenceTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='gromesh-seed-fixture-');self.addCleanup(self.temp.cleanup);self.r=Path(self.temp.name)
  self.base='// Existing seed fixture\npipelineJob(\'existing\') { disabled(true) }\n'
  code="import{persistentJobsManifest}from'./ci/jenkins/persistent-jobs.mjs';console.log(JSON.stringify(persistentJobsManifest('a'.repeat(40),process.argv[1])))"
  self.m=json.loads(subprocess.check_output([str(NODE),'--input-type=module','-e',code,hashlib.sha256(self.base.encode()).hexdigest()],cwd=REPO,text=True))
 def write(self,m=None):
  p=self.r/'manifest.json';p.write_text(json.dumps(m or self.m));return p
 def test_seven_exact_disabled_jobs_and_old_seed_preserved(self):
  out=self.base+extension(self.write(),self.base);self.assertTrue(out.startswith(self.base));self.assertEqual(out[len(self.base):].count('pipelineJob('),7);self.assertEqual(out[len(self.base):].count('disabled(true)'),7)
 def test_baseline_drift(self):
  with self.assertRaises(ValueError):extension(self.write(),self.base+'changed')
 def test_unexpected_job(self):
  self.m['jobs'][0]['name']='gromesh-gateway/gromesh-dev/gromesh-deploy'
  with self.assertRaises(ValueError):extension(self.write(),self.base)
 def test_enabled_or_extra_trigger_refused(self):
  for original,changed in [('<disabled>true</disabled>','<disabled>false</disabled>'),('<triggers/>','<triggers><evil/></triggers>')]:
   m=copy.deepcopy(self.m);j=m['jobs'][0];j['xml']=j['xml'].replace(original,changed);j['sha256']=hashlib.sha256(j['xml'].encode()).hexdigest()
   with self.assertRaises(ValueError):extension(self.write(m),self.base)
 def test_manifest_hash_and_runas_refused(self):
  for change in ['hash','runas']:
   m=copy.deepcopy(self.m);j=m['jobs'][0]
   if change=='hash':j['sha256']='0'*64
   else:j['xml']=j['xml'].replace('gromesh-ci-runner','j1-admin');j['sha256']=hashlib.sha256(j['xml'].encode()).hexdigest()
   with self.assertRaises(ValueError):extension(self.write(m),self.base)
 def test_moving_revision_refused(self):
  self.m['pipelineSha']='main'
  with self.assertRaises(ValueError):extension(self.write(),self.base)
if __name__=='__main__':unittest.main()
