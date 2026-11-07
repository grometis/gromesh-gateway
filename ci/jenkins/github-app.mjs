import { sign } from 'node:crypto';
import { repository, isSha, validateSource, assertCompleteCi } from './policy.mjs';

export function appJwt(appId, privateKey, now = Math.floor(Date.now()/1000)) {
  if (!/^[1-9][0-9]*$/.test(appId) || !Number.isSafeInteger(now)) throw new Error('Invalid GitHub App identity');
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const text = encode({alg:'RS256',typ:'JWT'})+'.'+encode({iat:now-60,exp:now+540,iss:appId});
  return text+'.'+sign('RSA-SHA256',Buffer.from(text),privateKey).toString('base64url');
}

export class GitHubApp {
  #token;
  #expires = 0;
  constructor({appId,installationId,privateKey,transport=fetch}) {
    if (!/^[1-9][0-9]*$/.test(appId) || !/^[1-9][0-9]*$/.test(installationId)) throw new Error('Invalid GitHub App IDs');
    this.appId=appId;this.installationId=installationId;this.privateKey=privateKey;this.transport=transport;
  }
  async installationToken() {
    if (this.#token && Date.now()<this.#expires-60000) return this.#token;
    const response = await this.transport(`https://api.github.com/app/installations/${this.installationId}/access_tokens`, {
      method:'POST', headers:{Authorization:`Bearer ${appJwt(this.appId,this.privateKey)}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
      body:JSON.stringify({repositories:['gromesh-gateway'],permissions:{contents:'read',metadata:'read',pull_requests:'read',checks:'write'}}), signal:AbortSignal.timeout(20000), redirect:'error'
    });
    if (!response.ok) throw new Error(`GitHub App token refused: HTTP ${response.status}`);
    const data=await response.json();
    if (typeof data.token!=='string' || !data.token || !Number.isFinite(Date.parse(data.expires_at))) throw new Error('Invalid installation token response');
    this.#token=data.token;this.#expires=Date.parse(data.expires_at);return this.#token;
  }
  async api(path,{method='GET',body}={}) {
    if (!/^\/(branches(?:\/main)?|pulls|check-runs)(?:\?[^\r\n]*)?$/.test(path)) throw new Error('Unapproved GitHub API path');
    const token=await this.installationToken();
    const response=await this.transport(`https://api.github.com/repos/${repository}${path}`,{
      method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'
    });
    if (!response.ok) throw new Error(`GitHub ${method} refused: HTTP ${response.status}`);
    return response.json();
  }
  async check({sha,buildUrl,externalId,conclusion,summary,report,expected}) {
    if (!isSha(sha) || !/^https:\/\/jenkins\.grometis\.com\/job\/gromesh-gateway\/job\/gromesh-ci\//.test(buildUrl ?? '')
        || !['success','failure','cancelled','timed_out','action_required'].includes(conclusion)
        || typeof externalId!=='string' || !/^[A-Za-z0-9:._/-]{1,200}$/.test(externalId)
        || typeof summary!=='string' || summary.length>1000 || /[\x00-\x08\x0b-\x1f]/.test(summary)) throw new Error('Invalid GitHub check identity/result');
    if (conclusion==='success') {
      assertCompleteCi(report,expected);
      if ((report.source.headSha??report.source.sha)!==sha || report.build.url!==buildUrl) throw new Error('GitHub check does not match CI build');
    }
    return this.api('/check-runs',{method:'POST',body:{name:'jenkins-ci',head_sha:sha,details_url:buildUrl,external_id:externalId,status:'completed',conclusion,output:{title:`Jenkins CI: ${conclusion}`,summary}}});
  }
  async pages(path) {
    const all=[];
    for(let page=1;page<=10;page++) {
      const rows=await this.api(`${path}?state=open&per_page=100&page=${page}`);
      if(!Array.isArray(rows)) throw new Error('Invalid GitHub list');
      all.push(...rows);
      if(rows.length<100)return all;
    }
    throw new Error('GitHub discovery exceeded bounded pagination; no partial coverage claim');
  }
  async discover() {
    const main=await this.api('/branches/main');
    const result=[{repository,sha:main.commit?.sha,event:'push',branch:'main',pr:null,baseSha:null,checkoutRef:'refs/heads/main'}];
    validateSource(result[0]);
    for(const pr of await this.pages('/pulls')) {
      if(pr.state!=='open' || pr.base?.repo?.full_name!==repository) throw new Error('Unexpected PR base identity');
      const source={repository,sha:pr.head?.sha,event:'pull_request',branch:pr.head?.ref,pr:pr.number,baseSha:pr.base?.sha,checkoutRef:`refs/pull/${pr.number}/head`};
      validateSource(source);result.push(source);
    }
    for(const branch of await this.pages('/branches')) {
      if(branch.name==='main')continue;
      const source={repository,sha:branch.commit?.sha,event:'push',branch:branch.name,pr:null,baseSha:null,checkoutRef:`refs/heads/${branch.name}`};
      validateSource(source);result.push(source);
    }
    return result;
  }
}
