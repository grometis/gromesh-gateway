"""Validated additive seed extension. No Controller API, credentials or execution."""
import hashlib,json,re,xml.etree.ElementTree as ET
from pathlib import Path
NAMES={**{'gromesh-gateway/gromesh-ci/gromesh-'+n:('Jenkinsfile.'+n if n in ('discovery','status') else 'Jenkinsfile.ci','gromesh-ci-runner') for n in ('main','prs','branches','discovery','status')},'gromesh-artifacts/gromesh-images':('Jenkinsfile.images','gromesh-release-runner'),'gromesh-delivery/gromesh-references':('Jenkinsfile.references','gromesh-delivery-runner')}
def literal(s):return "'"+s.replace('\\','\\\\').replace("'","\\'").replace('\r','\\r').replace('\n','\\n')+"'"
def extension(path,baseline):
 data=json.loads(Path(path).read_text())
 if set(data)!={'schema','pipelineSha','baselineSeedSha256','activationEnabled','jobs'} or data['schema']!='gromesh-persistent-jobs/v1' or not re.fullmatch('[a-f0-9]{40}',data.get('pipelineSha','')) or data.get('activationEnabled') is not False or data.get('baselineSeedSha256')!=hashlib.sha256(baseline.encode()).hexdigest():raise ValueError('persistent seed revision/baseline drift')
 jobs=data.get('jobs',[])
 if len(jobs)!=7 or {j.get('name') for j in jobs}!=set(NAMES):raise ValueError('exact seven jobs required')
 lines=['// J7 additive disabled jobs; no RunAs/ACL/worker activation implied.']
 for j in jobs:
  if set(j)!={'name','pipelineSha','scriptPath','xml','sha256'}:raise ValueError('job fields')
  script,principal=NAMES[j['name']];xml=j['xml'];sha=data['pipelineSha']
  if j['pipelineSha']!=sha or j['scriptPath']!=script or len(xml)>16384 or '<!' in xml or hashlib.sha256(xml.encode()).hexdigest()!=j['sha256']:raise ValueError('job manifest integrity')
  root=ET.fromstring(xml)
  # Exact reviewed XML skeleton, including empty triggers/disabled and no embedded Pipeline/grants.
  expected=ET.fromstring(EXPECTED.replace('__SHA__',sha).replace('__SCRIPT__',script).replace('__PRINCIPAL__',principal))
  def structure(n):return (n.tag,sorted(n.attrib.items()),(n.text or '').strip(),tuple(structure(c) for c in n))
  if structure(root)!=structure(expected):raise ValueError('unexpected job XML behavior')
  lines.extend(['pipelineJob('+literal(j['name'])+') {','  disabled(true)','  configure { node ->','    def source = new XmlParser().parseText('+literal(xml)+')','    node.attributes().clear(); node.attributes().putAll(source.attributes())','    node.children().clear(); source.children().each { node.append(it) }','  }','}'])
 return '\n'.join(lines)+'\n'
EXPECTED = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<flow-definition plugin=\"workflow-job\"><description>J5 PREPARED: disabled until review, worker qualification, RBAC and credentials. GitHub Actions remains authoritative.</description>\n<keepDependencies>false</keepDependencies><properties><org.jenkinsci.plugins.authorizeproject.AuthorizeProjectProperty plugin=\"authorize-project\"><strategy class=\"org.jenkinsci.plugins.authorizeproject.strategy.SpecificUsersAuthorizationStrategy\"><userid>__PRINCIPAL__</userid></strategy></org.jenkinsci.plugins.authorizeproject.AuthorizeProjectProperty></properties><definition class=\"org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition\" plugin=\"workflow-cps\">\n<scm class=\"hudson.plugins.git.GitSCM\" plugin=\"git\"><configVersion>2</configVersion><userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>https://github.com/grometis/gromesh-gateway.git</url></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs><branches><hudson.plugins.git.BranchSpec><name>__SHA__</name></hudson.plugins.git.BranchSpec></branches><doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations><submoduleCfg class=\"empty-list\"/><extensions/></scm>\n<scriptPath>__SCRIPT__</scriptPath><lightweight>false</lightweight></definition><triggers/><disabled>true</disabled></flow-definition>\n"
