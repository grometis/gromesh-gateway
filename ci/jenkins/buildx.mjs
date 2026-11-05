export async function configureNativeBuilder(policy,architecture,directory,env,execute){
 if(policy?.rootless!==true||policy.driver!=='remote'||!/^unix:\/\/\/run\/user\/[1-9][0-9]*\/buildkit\/buildkitd.sock$/.test(policy.endpoint??'')||!['amd64','arm64'].includes(architecture))throw new Error('Protected native BuildKit descriptor required');
 if(!/^[a-f0-9]{32}$/.test(env.GROMESH_CI_RUN??''))throw new Error('Private per-command builder identity required');
 const clean={...env,BUILDX_CONFIG:directory+'/.buildx-'+env.GROMESH_CI_RUN};
 await execute(['docker','buildx','create','--name','gromesh-native','--driver','remote',policy.endpoint],{env:clean,timeout:15000,maxBuffer:65536});
 const result=await execute(['docker','buildx','inspect','gromesh-native','--bootstrap','--format','{{json .}}'],{env:clean,timeout:30000,maxBuffer:65536});
 const info=JSON.parse(result.stdout),node=info.Nodes?.[0];
 const platforms=typeof node?.Platforms==='string'?node.Platforms.split(',').map(s=>s.trim().replace(/\*$/,'')):[];
 if(info.Driver!=='remote'||info.Nodes?.length!==1||node.Endpoint!==policy.endpoint||node.Status!=='running'||node.Buildkit!=='v0.23.2'||!platforms.includes('linux/'+architecture))throw new Error('Selected Buildx driver/endpoint/version/native platform mismatch');
 return clean;
}
