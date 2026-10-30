/* Shared, offline-capable theme preference. Loaded before styles to avoid a flash. */
(function () {
  'use strict';
  const key='halbach.ui.theme',html=document.documentElement;
  let current='light';
  try { if(localStorage.getItem(key)==='dark')current='dark'; } catch (_) {}
  html.dataset.theme=current;
  function sync() {document.querySelectorAll('[data-theme-switch]').forEach(input=>input.checked=current==='dark');}
  function set(theme,persist=true) {
    if(!['light','dark'].includes(theme))return;
    const changed=current!==theme;current=theme;html.dataset.theme=theme;sync();
    if(persist)try{localStorage.setItem(key,theme);}catch(_){}
    if(changed)window.dispatchEvent(new CustomEvent('hh:themechange',{detail:{theme}}));
  }
  function initialize() {
    sync();document.querySelectorAll('[data-theme-switch]').forEach(input=>input.addEventListener('change',()=>set(input.checked?'dark':'light')));
  }
  window.addEventListener('storage',event=>{if(event.key===key||event.key===null)set(event.newValue==='dark'?'dark':'light',false);});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
  window.HHTheme={current:()=>current,set};
})();
