export function kongCandidateRequired(event,files){
 if(!Array.isArray(files)||files.some(f=>typeof f!=='string'))throw new Error('Changed path inventory required');
 return event==='pull_request'&&files.some(f=>f.startsWith('images/kong/')||['.github/workflows/kong-image.yml','.github/workflows/kong-image-build.yml','.github/workflows/kong-image-candidate.yml'].includes(f));
}
