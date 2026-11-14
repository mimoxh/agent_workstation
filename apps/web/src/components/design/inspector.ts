// 注入到设计稿沙箱里的检查脚本：框选元素、就地改字、显示评论钉、实时应用旋钮。
// 沙箱是 opaque origin，和外层只通过 postMessage 通信；配色由外层把令牌的计算值传进来
export const INSPECTOR_SCRIPT = String.raw`(function(){
var mode='view',pins=[],hover=null,editing=null,original='',raf=0,sel=[];
var host=document.createElement('aw-design-overlay');
var root=host.attachShadow({mode:'open'});
root.innerHTML='<style>:host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none}'+
'#hover{position:fixed;display:none;outline:2px solid var(--aw-hover);outline-offset:1px;border-radius:2px}'+
'#pins,#sel{display:none}'+
'.sel{position:fixed;outline:2px dashed var(--aw-sel);outline-offset:2px;border-radius:2px}'+
'.pin{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border:0;padding:0;border-radius:11px 11px 11px 2px;background:var(--aw-pin);color:var(--aw-pin-ink);font:600 11px/22px system-ui,sans-serif;text-align:center;pointer-events:auto;cursor:pointer}'+
'.pin.on{outline:2px solid var(--aw-hover);outline-offset:1px}</style><div id="hover"></div><div id="pins"></div><div id="sel"></div>';
var box=root.getElementById('hover'),pinBox=root.getElementById('pins'),selBox=root.getElementById('sel');
function post(m){m.aw='design-frame';parent.postMessage(m,'*');}
function selectorOf(el){
  if(el===document.body||el===document.documentElement)return 'body';
  var parts=[];
  for(var n=el;n&&n!==document.body;n=n.parentElement){
    var i=1,s=n;while((s=s.previousElementSibling))i++;
    parts.unshift(CSS.escape(n.localName)+':nth-child('+i+')');
  }
  return 'body > '+parts.join(' > ');
}
function targetOf(e){
  var t=e.target;
  if(!t||t.nodeType!==1||t===host)return null;
  return t.closest('svg')||t;
}
function canEdit(el){return el.children.length===0&&el.textContent.trim()!==''&&!/^(SCRIPT|STYLE|INPUT|TEXTAREA|SELECT|OPTION)$/i.test(el.tagName);}
function outline(el){
  hover=el;
  if(!el){box.style.display='none';return;}
  var r=el.getBoundingClientRect();
  box.style.cssText='display:block;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px';
}
function find(selector){try{return selector?document.querySelector(selector):null;}catch(e){return null;}}
function place(){
  raf=0;
  if(hover)outline(hover);
  var missing=[];
  pins.forEach(function(p){
    var node=root.getElementById('pin-'+p.n),el=find(p.selector);
    if(!node)return;
    if(!el){node.style.display='none';if(p.selector)missing.push(p.n);return;}
    var r=el.getBoundingClientRect();
    node.style.display='block';
    node.style.left=Math.max(12,Math.min(innerWidth-12,r.right-6))+'px';
    node.style.top=Math.max(12,r.top+6)+'px';
  });
  sel.forEach(function(s,i){
    var node=root.getElementById('sel-'+i),el=find(s.selector);
    if(!node)return;
    if(!el){node.style.display='none';return;}
    var r=el.getBoundingClientRect();
    node.style.display='block';
    node.style.left=r.left+'px';node.style.top=r.top+'px';
    node.style.width=r.width+'px';node.style.height=r.height+'px';
  });
  post({type:'missing',pins:missing});
}
function schedule(){if(!raf)raf=requestAnimationFrame(place);}
function renderPins(){
  pinBox.textContent='';
  pins.forEach(function(p){
    var b=document.createElement('button');
    b.id='pin-'+p.n;b.className='pin'+(p.active?' on':'');b.textContent=String(p.n);
    b.addEventListener('click',function(ev){ev.stopPropagation();ev.preventDefault();post({type:'pin',n:p.n});});
    pinBox.appendChild(b);
  });
  schedule();
}
function itemOf(el){
  return {selector:selectorOf(el),anchor:(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,60),tag:el.localName,html:(el.outerHTML||'').slice(0,1500)};
}
function postSel(){post({type:'select',items:sel});}
function renderSel(){
  selBox.textContent='';
  sel.forEach(function(s,i){
    var d=document.createElement('div');
    d.id='sel-'+i;d.className='sel';
    selBox.appendChild(d);
  });
  schedule();
}
function setSel(items){
  sel=items;
  renderSel();
  postSel();
}
function syncSel(keys){
  sel=(keys||[]).map(function(k){var el=find(k);return el?itemOf(el):null;}).filter(function(x){return !!x;});
  renderSel();
}
function finish(){
  var el=editing;
  if(!el)return;
  editing=null;
  el.removeAttribute('contenteditable');
  el.removeEventListener('blur',finish);
  el.removeEventListener('keydown',onEditKey);
  var text=el.textContent;
  if(text!==original&&text.trim()!=='')post({type:'edit',selector:selectorOf(el),text:text});
  else el.textContent=original;
}
function onEditKey(e){
  if(e.key==='Escape'){editing.textContent=original;editing.blur();}
  else if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();editing.blur();}
}
function startEdit(el){
  editing=el;original=el.textContent;
  el.setAttribute('contenteditable','plaintext-only');
  el.addEventListener('blur',finish);
  el.addEventListener('keydown',onEditKey);
  el.focus();
  getSelection().selectAllChildren(el);
  outline(null);
}
addEventListener('mousemove',function(e){
  if(mode==='view'||editing)return;
  var t=targetOf(e);
  outline(t&&(mode==='comment'||mode==='select'||canEdit(t))?t:null);
},true);
document.addEventListener('mouseleave',function(){outline(null);});
addEventListener('click',function(e){
  var t=targetOf(e);
  if(mode==='view'){
    var a=t&&t.closest('a[href]');
    if(a&&a.getAttribute('href').charAt(0)!=='#')e.preventDefault();
    return;
  }
  if(editing&&t&&editing.contains(t))return;
  e.preventDefault();e.stopPropagation();
  if(!t)return;
  if(mode==='comment')post({type:'pick',selector:selectorOf(t),anchor:(t.textContent||'').trim().replace(/\s+/g,' ').slice(0,60),tag:t.localName});
  else if(mode==='select'){
    var item=itemOf(t),hit=-1;
    for(var i=0;i<sel.length;i++)if(sel[i].selector===item.selector){hit=i;break;}
    if(e.shiftKey){
      if(hit>=0)sel.splice(hit,1);
      else if(sel.length<8)sel.push(item);
      renderSel();postSel();
    }else setSel([item]);
  }
  else if(canEdit(t))startEdit(t);
},true);
addEventListener('keydown',function(e){
  if(mode==='select'&&e.key==='Escape'&&sel.length){e.preventDefault();setSel([]);}
},true);
addEventListener('submit',function(e){e.preventDefault();},true);
addEventListener('scroll',schedule,true);
addEventListener('resize',schedule);
addEventListener('error',function(e){if(e.message)post({type:'issue',text:e.message});});
document.addEventListener('securitypolicyviolation',function(e){post({type:'issue',text:'沙箱拦截了 '+(e.blockedURI||e.violatedDirective)});});
addEventListener('message',function(e){
  var d=e.data;
  if(e.source!==parent||!d||d.aw!=='design'||d.type!=='state')return;
  if(!host.isConnected)document.documentElement.appendChild(host);
  for(var k in d.colors)host.style.setProperty(k,d.colors[k]);
  for(var v in d.vars)document.documentElement.style.setProperty(v,d.vars[v]);
  if(mode!==d.mode){if(editing)editing.blur();outline(null);}
  mode=d.mode;
  document.documentElement.style.cursor=(mode==='comment'||mode==='select')?'crosshair':'';
  pinBox.style.display=mode==='comment'?'block':'none';
  selBox.style.display=mode==='select'?'block':'none';
  pins=d.pins;renderPins();
  if(d.selected&&d.selected.join('|')!==sel.map(function(s){return s.selector;}).join('|'))syncSel(d.selected);
});
})();`;
