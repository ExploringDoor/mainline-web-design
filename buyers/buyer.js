/* Buyer pages: highlight the rail as you scroll, and send the closing form to /api/contact. */
(function(){
  var links=[].slice.call(document.querySelectorAll('.rail a'));
  if(links.length){
    var secs=links.map(function(a){ return document.getElementById(a.getAttribute('href').slice(1)); });
    var ticking=false;
    var mark=function(){
      ticking=false;
      var line=innerHeight*0.4, cur=-1;
      secs.forEach(function(s,i){ if(s&&s.getBoundingClientRect().top<line) cur=i; });
      links.forEach(function(a,i){ a.classList.toggle('on',i===cur); });
    };
    addEventListener('scroll',function(){ if(!ticking){ ticking=true; requestAnimationFrame(mark); } },{passive:true});
    mark();
  }

  document.querySelectorAll('[data-ev]').forEach(function(el){
    el.addEventListener('click',function(){ if(window.gtag) gtag('event',el.getAttribute('data-ev'),{page:location.pathname}); });
  });

  var f=document.getElementById('ask'); if(!f) return;
  var btn=f.querySelector('button'), msg=f.querySelector('.msg'), label=btn.textContent;
  var refParam=new URLSearchParams(location.search).get('ref');
  f.addEventListener('submit',async function(e){
    e.preventDefault(); msg.className='msg'; msg.textContent='';
    var d=Object.fromEntries(new FormData(f).entries());
    if(!d.name||!d.email||!d.org){ msg.className='msg err'; msg.textContent='Name, email and your organization are required.'; return; }
    var notes=(d.notes||'').trim();
    if(d.phone) notes='Phone: '+d.phone+(notes?'\n\n'+notes:'');
    var payload={name:d.name,email:d.email,org:d.org,orgType:d.orgType||f.dataset.type||'',sport:d.sport||f.dataset.sport||'',teams:d.teams||'',notes:notes,
      ref:refParam||f.dataset.ref||'',page:location.pathname.replace(/^\//,'')||'index.html',website2:d.website2||''};
    btn.disabled=true; btn.textContent='Sending...';
    try{
      var r=await fetch('/api/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      var j={}; try{ j=await r.json(); }catch(_){}
      if(r.ok&&j.ok){
        var first=(d.name.split(' ')[0]||'').replace(/[<>&]/g,'');
        f.innerHTML='<div class="done"><h3>Got it, '+first+'.</h3><p>You will hear from me within 24 hours. If you would rather talk now, <a href="/book.html">grab a 15-minute call</a>.</p></div>';
        if(window.gtag) gtag('event','contact_submit',{page:payload.page});
        return;
      }
      throw new Error(j.error||'send failed');
    }catch(err){
      btn.disabled=false; btn.textContent=label;
      var m='mailto:adam@mainline-webdesign.com?subject='+encodeURIComponent('New inquiry: '+d.org)+'&body='+encodeURIComponent(d.name+'\n'+d.email+'\n'+notes);
      msg.className='msg err'; msg.innerHTML='Could not send right now. <a href="'+m+'">Email me directly instead</a>.';
    }
  });
})();
