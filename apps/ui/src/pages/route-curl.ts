interface CurlRoute {protocols:readonly string[];methods?:readonly string[];hosts?:readonly string[];headers?:Record<string,readonly string[]>}
const quote=(value:string)=>`'${value.replaceAll("'", "'\\''")}'`;
/** The public entry is explicitly confirmed by the user; never inferred from a service or the UI origin. */
export function buildRouteCurl(route:CurlRoute,entry:string,method:string):string {
 const invalid=()=>Error('Informe uma URL pública HTTP(S), sem credenciais, query ou fragmento, compatível com esta rota.');
 if(!entry||/[\s\u0000-\u001f\u007f]/.test(entry)||/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(entry))throw invalid();
 let url:URL;try{url=new URL(entry);}catch{throw invalid();}
 if(!['http:','https:'].includes(url.protocol)||!route.protocols.includes(url.protocol.slice(0,-1))||url.username||url.password||url.search||url.hash)throw invalid();
 if(route.hosts?.length&&!route.hosts.some(raw=>{
  const host=raw.toLowerCase(),actual=url.hostname.toLowerCase();
  return host.startsWith('*.')?actual.endsWith(host.slice(1))&&actual.length>host.length-1:host.endsWith('.*')?actual.startsWith(host.slice(0,-1))&&actual.length>host.length-1:host===actual;
 }))throw invalid();
 if(!/^[A-Z]+$/.test(method)||(route.methods&&!route.methods.includes(method)))throw Error('Selecione um método permitido pela rota.');
 const headers=Object.keys(route.headers??{}).map(name=>{
  if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))throw invalid();
  return `  --header ${quote(`${name}: <VALOR>`)}`;
 });
 return [`curl --globoff --request ${quote(method)} --url ${quote(url.href)}`,...headers].join(' \\\n');
}
