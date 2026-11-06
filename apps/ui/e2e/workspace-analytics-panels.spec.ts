import AxeBuilder from '@axe-core/playwright';
import {expect,mockSession,test} from './fixtures';
import {checkLayout} from './layout';
const A='11111111-1111-4111-8111-111111111111',I='22222222-2222-4222-8222-222222222222',R='33333333-3333-4333-8333-333333333333',stamp='2026-11-05T03:00:00Z';
const stats=(requests=0)=>({requests,errors4xx:0,errors5xx:0,errorRate:0,p50Ms:requests?2:null,p95Ms:requests?2:null,p99Ms:requests?2:null});
for(const width of [390,768,1440])test(`prepared workspace indicators remain isolated accessible and unavailable-aware at ${width}px`,async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('status of 403')&&!m.text().includes('status of 502'))errors.push(m.text());});
 const traffic:string[]=[],workspace={id:A,key:A,name:'Workspace sintético',slug:'synthetic',status:'active',activeRelease:null};let enabled=false,unavailable=false;
 await page.route(/\/src\/pages\/WorkspaceAnalyticsPanels\.tsx(?:\?.*)?$/,async route=>{
  const response=await route.fetch(),body=await response.text();expect(body).toContain('WORKSPACE_ANALYTICS_ENABLED = false');await route.fulfill({response,body:enabled?body.replace('WORKSPACE_ANALYTICS_ENABLED = false','WORKSPACE_ANALYTICS_ENABLED = true'):body});
 });
 await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//,async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(path.includes('/analytics/')){
   traffic.push(path);if(unavailable)return route.fulfill({status:502,json:{title:'Bad Gateway',status:502,code:'analytics-not-ready'}});
   const from=url.searchParams.get('from')!,to=url.searchParams.get('to')!,context={scope:'workspace',instanceId:I,workspaceId:A,from,to,generatedAt:to,attributionVersion:'route-history-v2',retention:'per-route-1-to-7-days',delivery:'best-effort'};
   if(path.endsWith('/summary')){const interval=url.searchParams.get('interval')!,ms=interval==='1m'?60000:interval==='5m'?300000:900000;return route.fulfill({json:{...context,interval,totals:stats(2),series:Array.from({length:Math.ceil((Date.parse(to)-Date.parse(from))/ms)},(_,i)=>({ts:new Date(Date.parse(from)+i*ms).toISOString(),...stats(i===0?2:0)}))}});}
   return route.fulfill({json:{...context,by:'requests',items:[{routeId:R,routeName:'Rota sintética de pedidos',serviceId:null,...stats(2)}]}});
  }
  if(path==='/api/v1/auth/csrf')return route.fulfill({json:{csrfToken:'synthetic'}});
  if(path==='/api/v2/workspace-creation-policy')return route.fulfill({status:403,json:{title:'Forbidden',status:403}});
  if(path==='/api/v2/workspaces')return route.fulfill({json:{items:[workspace],nextCursor:null}});
  if(path===`/api/v2/workspaces/${A}`)return route.fulfill({json:workspace});
  if(path.endsWith('/variables')||path.endsWith('/releases'))return route.fulfill({json:[]});
  return route.fulfill({json:{items:[],nextCursor:null}});
 });
 await mockSession(page,{id:A,name:'Ana',email:'ana@example.test',role:'viewer',active:true,createdAt:stamp,updatedAt:stamp});await page.context().addCookies([{name:'gromesh_session',value:'synthetic-analytics-panels',url:test.info().project.use.baseURL!}]);
 await page.setViewportSize({width,height:900});await page.goto(`/workspaces/${A}/overview`);await expect(page.getByRole('heading',{name:'Visão geral do Workspace',exact:true})).toBeVisible();expect(traffic).toEqual([]);await expect(page.getByRole('region',{name:'Indicadores de tráfego do Workspace'})).toHaveCount(0);
 enabled=true;await page.reload();await expect(page.getByRole('table',{name:'Rotas com mais requisições'})).toBeVisible();expect(traffic.some(p=>p.endsWith('/timeseries'))).toBe(false);
 await page.getByLabel('Período dos indicadores').focus();await expect(page.getByLabel('Período dos indicadores')).toBeFocused();await page.getByLabel('Período dos indicadores').selectOption('1h');await expect(page.getByRole('cell',{name:'Rota sintética de pedidos'})).toBeVisible();
 await checkLayout(page);expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([]);await page.screenshot({path:test.info().outputPath(`analytics-${width}.png`),fullPage:true});
 unavailable=true;await page.getByLabel('Período dos indicadores').selectOption('24h');await expect(page.getByRole('heading',{name:'Analytics indisponível',exact:true})).toBeVisible();await expect(page.getByText('Nenhuma requisição no período.',{exact:true})).not.toBeVisible();await expect(page.getByRole('table',{name:'Rotas com mais requisições'})).not.toBeVisible();
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([]);
 await expect(page).toHaveTitle('Gromesh Gateway');await expect(page).toHaveURL(new RegExp(`/workspaces/${A}/overview$`));await expect(page.locator('vite-error-overlay')).toHaveCount(0);expect(errors).toEqual([]);
});
