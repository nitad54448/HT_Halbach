(function () {
  'use strict';
  const search=document.getElementById('help-search'),status=document.getElementById('help-search-status');
  const sections=[...document.querySelectorAll('.doc-section')],links=[...document.querySelectorAll('[data-doc-link]')];
  const normalize=value=>value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
  const text=new Map(sections.map(section=>[section,normalize(section.textContent+' '+(section.dataset.keywords||''))]));
  function filter() {
    const terms=normalize(search.value.trim()).split(/\s+/).filter(Boolean);
    let matches=0;
    for(const section of sections){const visible=terms.every(term=>text.get(section).includes(term));section.hidden=!visible;if(visible)matches++;}
    for(const link of links)link.hidden=document.getElementById(link.hash.slice(1)).hidden;
    document.getElementById('help-empty').hidden=matches>0;
    status.textContent=terms.length?`${matches} of ${sections.length} sections match`:`${sections.length} sections · works offline`;
  }
  search.disabled=false;search.addEventListener('input',filter);
  document.getElementById('help-clear').onclick=()=>{search.value='';filter();search.focus();};
  search.addEventListener('keydown',event=>{if(event.key==='Escape'){search.value='';filter();}});
  document.getElementById('help-print').onclick=()=>window.print();
  for(const link of links)link.addEventListener('click',()=>{search.value='';filter();});
  function active(){for(const link of links)link.setAttribute('aria-current',String(link.hash===location.hash));}
  window.addEventListener('hashchange',active);active();filter();
})();
