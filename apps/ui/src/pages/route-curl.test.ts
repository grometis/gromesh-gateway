import {describe,expect,it} from 'vitest';
import {buildRouteCurl,knownRouteCurlEntry,matchesPublishedRoute} from './route-curl';
const route={protocols:['https'],methods:['GET'],hosts:['api.example.test'],headers:{Authorization:['never-copy-this-secret']}};
describe('public route cURL',()=>{
 it('uses the explicit public entry, method and placeholder headers without credentials',()=>{
  const command=buildRouteCurl(route,'https://api.example.test/payments/orders','GET');
  expect(command).toContain("--url 'https://api.example.test/payments/orders'");
  expect(command).toContain("--request 'GET'");expect(command).toContain('Authorization: <VALOR>');expect(command).not.toContain('never-copy-this-secret');
 });
 it.each(['','http://api.example.test/orders','https://admin.example.test/orders','https://user:secret@api.example.test/orders','https://api.example.test/orders?token=secret','https://api.example.test/orders#secret','https://api.example.test/\norders'])('refuses ambiguous or unsafe public entry %s',url=>{
  expect(()=>buildRouteCurl(route,url,'GET')).toThrow();
 });
 it('allows the matching public wildcard and IPv6 with explicit port',()=>{
  expect(buildRouteCurl({...route,hosts:['*.example.test']},'https://edge.example.test/a','GET')).toContain('edge.example.test');
  expect(buildRouteCurl({...route,hosts:['[2001:db8::1]']},'https://[2001:db8::1]:8443/a','GET')).toContain('[2001:db8::1]:8443');
 });
 it('quotes shell metacharacters in a user-confirmed path without executing',()=>{
  const value=buildRouteCurl(route,"https://api.example.test/a'$(id)",'GET');
  expect(value).toContain("a'\\''$(id)");
 });
 it('refuses unsupported methods, protocols and injected header names',()=>{
  expect(()=>buildRouteCurl(route,'https://api.example.test/a','POST')).toThrow();
  expect(()=>buildRouteCurl({...route,protocols:['grpcs']},'https://api.example.test/a','GET')).toThrow();
  expect(()=>buildRouteCurl({...route,headers:{'Bad\nHeader':['secret']}},'https://api.example.test/a','GET')).toThrow();
 });
});

describe('known Gateway entry',()=>{
 it('uses only an explicit Gateway origin and a single known published literal path',()=>{
  expect(knownRouteCurlEntry(route,'https://api.example.test',['/orders'])).toBe('https://api.example.test/orders');
 });
 it.each([undefined,'https://user:secret@api.example.test','https://api.example.test/admin','https://api.example.test/?key=secret'])('does not guess an unknown or unsafe origin %s',origin=>{
  expect(knownRouteCurlEntry(route,origin,['/orders'])).toBeNull();
 });
 it('requires path evidence, refusing ambiguous and regex paths or a different matching host',()=>{
  for(const paths of [undefined,[],['/one','/two'],['~/orders/[0-9]+'],['//elsewhere.test/orders'],['/\\elsewhere.test/orders'],['/a/../admin'],['/%2e%2e/admin']])expect(knownRouteCurlEntry(route,'https://api.example.test',paths)).toBeNull();
  expect(knownRouteCurlEntry(route,'https://internal.example.test',['/orders'])).toBeNull();
 });
});


it('never mixes published paths with changed or unknown matching criteria',()=>{
 const current={...route,paths:['/orders']};
 expect(matchesPublishedRoute(current,current)).toBe(true);
 expect(matchesPublishedRoute({...current,methods:['POST']},current)).toBe(false);
 expect(matchesPublishedRoute({...current,hosts:['other.example.test']},current)).toBe(false);
 expect(matchesPublishedRoute({...current,paths:['/draft-orders']},current)).toBe(false);
 expect(matchesPublishedRoute(current,undefined)).toBe(false);
 expect(matchesPublishedRoute(current,{paths:['/orders']})).toBe(false);
});
