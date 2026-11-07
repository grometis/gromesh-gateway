import AxeBuilder from '@axe-core/playwright';
import type {Page} from '@playwright/test';
import {expect,mockSession,test} from './fixtures';
const W='6d3e8b20-4c5e-4d6f-9a70-00000000000a',B='6d3e8b20-4c5e-4d6f-9a70-00000000000b',R='6d3e8b20-4c5e-4d6f-9a70-0000000000c1';
const stamp={createdAt:'2026-11-06T12:00:00Z',updatedAt:'2026-11-06T12:00:00Z'};
async function setup(page:Page){
 const workspaces=[{id:W,key:W,name:'Pagamentos',slug:'payments',status:'active',activeRelease:null},{id:B,key:B,name:'Catálogo',slug:'catalog',status:'active',activeRelease:null}];
 await mockSession(page,{id:R,name:'Ana Demo',email:'ana@example.test',role:'admin',active:true,...stamp});
 await page.route('**/api/v2/**',async request=>{
  const path=new URL(request.request().url()).pathname,method=request.request().method();
  if(path.endsWith('/workspace-creation-policy'))return request.fulfill({json:{mode:'restricted-request',creatorBecomesAdmin:false,updatedAt:null,updatedBy:null,workspacesMode:'lab',stage:'dev',caller:{canCreate:true,canRequest:false,canDecide:true}}});
  if(path==='/api/v2/workspaces'){
   if(method==='POST'){
    const body=request.request().postDataJSON() as {name:string;slug:string};
    if(workspaces.some(w=>w.slug===body.slug))return request.fulfill({status:409,json:{title:'Conflict',status:409,code:'slug-taken',errors:[{path:'slug',message:'Slug já utilizado.'}]}});
    const created={...workspaces[0]!,...body,id:'6d3e8b20-4c5e-4d6f-9a70-00000000000c',key:'6d3e8b20-4c5e-4d6f-9a70-00000000000c'};workspaces.push(created);return request.fulfill({status:201,json:created});
   }
   return request.fulfill({json:{items:workspaces,nextCursor:null}});
  }
  const match=/^\/api\/v2\/workspaces\/([^/]+)(.*)$/.exec(path),workspace=workspaces.find(w=>w.id===match?.[1]);
  if(!workspace)return request.fulfill({status:404,json:{status:404,title:'Not Found'}});
  if(!match![2])return request.fulfill({json:workspace});
  if(match![2]==='/routes')return request.fulfill({json:{items:workspace.id===W||workspace.id===B?[{id:R,serviceId:R,name:`orders-${workspace.slug}`,paths:['/orders'],methods:['GET'],hosts:['api.example.test'],protocols:['https'],stripPath:false,preserveHost:false,pathCompatibility:'workspace-default',...stamp}]:[],nextCursor:null}});
  if(match![2]==='/variables')return request.fulfill({json:[]});
  if(['/consumers','/plugins','/upstreams','/certificates'].includes(match![2]!))return request.fulfill({json:{items:[],nextCursor:null}});
  if(match![2]==='/services'&&workspace.id!==W&&workspace.id!==B)return request.fulfill({json:{items:[],nextCursor:null}});
  if(match![2]==='/services')return request.fulfill({json:{items:[{id:R,workspaceId:workspace.id,name:'orders-api',host:'orders.internal',protocol:'http',port:80,upstreamId:null,enabled:true,...stamp}],nextCursor:null}});
  if(match![2]==='/releases')return request.fulfill({json:[]});
  return request.fulfill({status:404,json:{status:404,title:'Not Found'}});
 });
}
const shot=async(page:Page,name:string)=>{const dir=process.env.GROMESH_UI_SCREENSHOT_DIR;if(dir)await page.screenshot({path:`${dir}/${name}.png`,fullPage:true});};
for(const width of [390,768,1440]){
 test(`Malha, scoped navigation and safe cURL at ${width}px`,async({page,context})=>{
  await page.setViewportSize({width,height:900});await setup(page);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/workspaces');
  const logo=page.getByRole('link',{name:'gromesh, início',exact:true}).locator('img');
  await expect(logo).toHaveAttribute('src','/brand/gromesh-logo-claro.svg');await expect(logo).toHaveJSProperty('height',34);
  await shot(page,`login-${width}`);
  await page.getByLabel('E-mail',{exact:true}).fill('ana@example.test');await page.getByLabel('Senha',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Entrar',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Workspaces',exact:true})).toBeVisible();
  await expect(logo).toHaveAttribute('src','/brand/gromesh-logo-escuro.svg');await expect(logo).toHaveJSProperty('height',20);
  await page.keyboard.press('/');await expect(page.getByRole('searchbox',{name:'Buscar Workspaces'})).toBeFocused();
  await page.getByRole('searchbox',{name:'Buscar Workspaces'}).fill('Catálogo');await expect(page.getByRole('table',{name:'Workspaces'})).not.toContainText('Pagamentos');
  await page.getByRole('searchbox',{name:'Buscar Workspaces'}).fill('');await shot(page,`workspaces-${width}`);
  await page.getByRole('link',{name:'Pagamentos',exact:true}).click();
  await page.goto(`/workspaces/${W}/routes`);await expect(page.getByRole('table',{name:'Rotas',exact:true})).toBeVisible();
  await page.keyboard.press('/');await expect(page.getByRole('searchbox',{name:'Buscar rotas'})).toBeFocused();await page.keyboard.type('/');await expect(page.getByRole('searchbox',{name:'Buscar rotas'})).toHaveValue('/');await page.getByRole('searchbox',{name:'Buscar rotas'}).fill('');
  await expect(page.getByText('Path configurado:',{exact:false})).toHaveCount(0);
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.getByRole('button',{name:'Copiar cURL de orders-payments',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'Copiar cURL de orders-payments',exact:true});
  await modal.getByLabel('URL pública da rota',{exact:true}).fill('https://api.example.test/payments/orders');await modal.getByRole('button',{name:'Copiar comando',exact:true}).click();await expect(modal.getByRole('status')).toHaveText('cURL copiado');
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain("--url 'https://api.example.test/payments/orders'");
  await shot(page,`route-curl-${width}`);
  await page.keyboard.press('Escape');await expect(modal).toHaveCount(0);await expect(page.getByRole('button',{name:'Copiar cURL de orders-payments',exact:true})).toBeFocused();
  await page.getByLabel('Workspace v2',{exact:true}).selectOption(B);await expect(page).toHaveURL(`/workspaces/${B}/routes`);await expect(page.getByRole('table',{name:'Rotas',exact:true})).toContainText('orders-catalog');await expect(page.getByRole('table',{name:'Rotas',exact:true})).not.toContainText('orders-payments');
  await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await shot(page,`routes-${width}`);
  for(const [path,title,name]of [['overview','Visão geral do Workspace','workspace-overview'],['variables','Variáveis','variables'],['releases','Releases','releases'],['requests','Requisições','workspace-requests']] as const){
   await page.goto(`/workspaces/${W}/${path}`);await expect(page.getByRole('heading',{level:1})).toContainText(title);await shot(page,`${name}-${width}`);
  }
  expect(errors).toEqual([]);
 });
}
test('copy failure never announces success and Workspace creation enters the returned identity',async({page})=>{
 await setup(page);await page.goto('/workspaces');await page.getByLabel('E-mail',{exact:true}).fill('ana@example.test');await page.getByLabel('Senha',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Entrar',exact:true}).click();
 await page.getByRole('button',{name:'Criar Workspace',exact:true}).click();const form=page.getByRole('dialog',{name:'Criar Workspace',exact:true});await form.getByRole('button',{name:'Criar',exact:true}).click();await expect(form.getByText('Informe o nome.',{exact:true})).toBeVisible();
 await form.getByLabel('Nome',{exact:true}).fill('Parceiros');await form.getByRole('button',{name:'Criar',exact:true}).click();await expect(form).toHaveCount(0);await page.getByRole('link',{name:'Entrar no novo Workspace',exact:true}).click();await expect(page).toHaveURL('/workspaces/6d3e8b20-4c5e-4d6f-9a70-00000000000c/overview');await expect(page.getByRole('heading',{name:'Visão geral do Workspace',exact:true})).toBeVisible();await expect(page.getByLabel('Identidade do Workspace',{exact:true})).toContainText('Parceiros');
 await page.goto(`/workspaces/${W}/routes`);await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(Error('denied'))}}));
 await page.getByRole('button',{name:'Copiar cURL de orders-payments',exact:true}).click();const modal=page.getByRole('dialog',{name:'Copiar cURL de orders-payments',exact:true});await modal.getByLabel('URL pública da rota').fill('https://api.example.test/payments/orders');await modal.getByRole('button',{name:'Copiar comando'}).click();await expect(modal.getByRole('alert')).toContainText('Não foi possível copiar');await expect(modal.getByRole('status')).not.toHaveText('cURL copiado');
});

test('late clipboard completion cannot announce success in a reopened dialog',async({page})=>{
 await setup(page);await page.goto(`/workspaces/${W}/routes`);await page.getByLabel('E-mail',{exact:true}).fill('ana@example.test');await page.getByLabel('Senha',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Entrar',exact:true}).click();
 await page.evaluate(()=>{
  let finish:()=>void=()=>{};
  Reflect.set(window,'finishDesignClipboard',()=>finish());
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise<void>(resolve=>{finish=resolve;})}});
 });
 const button=page.getByRole('button',{name:'Copiar cURL de orders-payments',exact:true});await button.click();
 const modal=page.getByRole('dialog',{name:'Copiar cURL de orders-payments',exact:true});await modal.getByLabel('URL pública da rota').fill('https://api.example.test/payments/orders');await modal.getByRole('button',{name:'Copiar comando'}).click();await expect(modal.getByRole('status')).toHaveText('Copiando…');
 await page.keyboard.press('Escape');await expect(modal).toHaveCount(0);await button.click();await modal.getByLabel('URL pública da rota').fill('https://api.example.test/payments/another-path');
 await page.evaluate(async()=>{(Reflect.get(window,'finishDesignClipboard') as ()=>void)();await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
 await expect(modal.getByRole('status')).toBeEmpty();await expect(modal.getByRole('button',{name:'Copiar comando'})).toBeEnabled();
});
