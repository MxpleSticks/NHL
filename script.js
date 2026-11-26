/* No accounts, tracking, third-party scripts or dependencies. Only schedule,
   team, score and status fields from ESPN are read. All profile data stays local. */
(() => {
  'use strict';
  const API = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl';
  const STANDINGS_API = 'https://site.api.espn.com/apis/v2/sports/hockey/nhl';
  const PUCKALYTICS_TEAMS={
    ANA:'anaheim-ducks',BOS:'boston-bruins',BUF:'buffalo-sabres',CGY:'calgary-flames',CAR:'carolina-hurricanes',CHI:'chicago-blackhawks',COL:'colorado-avalanche',CBJ:'columbus-blue-jackets',
    DAL:'dallas-stars',DET:'detroit-red-wings',EDM:'edmonton-oilers',FLA:'florida-panthers',LAK:'los-angeles-kings',MIN:'minnesota-wild',MTL:'montreal-canadiens',NSH:'nashville-predators',
    NJD:'new-jersey-devils',NYI:'new-york-islanders',NYR:'new-york-rangers',OTT:'ottawa-senators',PHI:'philadelphia-flyers',PIT:'pittsburgh-penguins',SJS:'san-jose-sharks',SEA:'seattle-kraken',
    STL:'st-louis-blues',TBL:'tampa-bay-lightning',TOR:'toronto-maple-leafs',UTA:'utah-mammoth',VAN:'vancouver-canucks',VGK:'vegas-golden-knights',WSH:'washington-capitals',WPG:'winnipeg-jets'
  };
  const DB_NAME = 'nhl-local-predictions';
  const LOCAL_KEY = 'nhl-local-profile-v1';
  const ZONE = 'America/New_York';
  const $ = id => document.getElementById(id);
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dayFormatter = new Intl.DateTimeFormat('en-CA', {timeZone:ZONE, year:'numeric', month:'2-digit', day:'2-digit'});
  const dateKey = value => {
    const p = Object.fromEntries(dayFormatter.formatToParts(new Date(value)).map(p => [p.type,p.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const today = () => dateKey(Date.now());
  const dayDate = key => new Date(`${key}T12:00:00Z`);
  const addDays = (key, count) => { const d=dayDate(key); d.setUTCDate(d.getUTCDate()+count); return d.toISOString().slice(0,10); };
  const monday = key => addDays(key, -((dayDate(key).getUTCDay()+6)%7));
  const seasonFor = key => { const year=Number(key.slice(0,4)); return Number(key.slice(5,7))>=9 ? year+1 : year; };
  const seasonLabel = year => `${year-1}–${String(year).slice(-2)}`;
  const formatDay = (key, options) => new Intl.DateTimeFormat('en-US', {...options,timeZone:'UTC'}).format(dayDate(key));
  const isoNow = () => new Date().toISOString();
  const emptyProfile = () => ({schemaVersion:1, username:'', usernameUpdatedAt:'1970-01-01T00:00:00.000Z', theme:'light', themeUpdatedAt:'1970-01-01T00:00:00.000Z', predictions:[]});
  let profile=emptyProfile(), db=null, storageMode='memory', saveQueue=Promise.resolve();
  let week=monday(today()), activePage='schedule', gameFilter='upcoming', weekGeneration=0;
  let historySelection=null;
  let games=new Map(), loadedDays=new Set(), dayFetched=new Map(), loading=false, refreshRunning=false, lastRefresh=null;
  const teamCache=new Map(), teamRequests=new Map();
  const standingsCache=new Map(), standingsRequests=new Map();
  let channel=null;
  let openTeamDetails=null, popoverTimer=null, hoverTimer=null, popoverRequest=0, suppressPopoverFocus=false, clearedHighlight=null;

  function notice(message) { $('notice').textContent=message; $('notice').hidden=!message; }
  // Reuse existing rows, controls and logos. Background refreshes should only
  // change the text or attributes that actually changed, without resetting focus.
  function renderMarkup(container,html) {
    if(container.renderedHTML===html) return;
    const next=container.cloneNode(false);
    next.innerHTML=html;
    function sync(parent,incoming) {
      const key=node=>node.nodeType===1 ? node.getAttribute('data-row-key') : null;
      const keyed=new Map([...parent.childNodes].filter(node=>key(node)).map(node=>[key(node),node]));
      let cursor=parent.firstChild;
      for(const fresh of [...incoming.childNodes]) {
        let node=key(fresh) ? keyed.get(key(fresh)) : cursor && !key(cursor) ? cursor : null;
        if(!node || node.nodeType!==fresh.nodeType || node.nodeName!==fresh.nodeName) {
          node=fresh.cloneNode(true); parent.insertBefore(node,cursor);
        } else {
          if(node!==cursor) parent.insertBefore(node,cursor);
          if(node.nodeType===1) {
            for(const attribute of [...node.attributes]) {
              if(!fresh.hasAttribute(attribute.name) && !(node.tagName==='IMG' && attribute.name==='style')) node.removeAttribute(attribute.name);
            }
            for(const attribute of [...fresh.attributes]) {
              if(node.getAttribute(attribute.name)!==attribute.value) node.setAttribute(attribute.name,attribute.value);
            }
            sync(node,fresh);
          } else if(node.nodeValue!==fresh.nodeValue) node.nodeValue=fresh.nodeValue;
        }
        cursor=node.nextSibling;
      }
      while(cursor) { const next=cursor.nextSibling; parent.removeChild(cursor); cursor=next; }
    }
    sync(container,next);
    container.renderedHTML=html;
  }
  function normalizeTeam(t) {
    const abbreviation=String(t.abbreviation || t.shortDisplayName || t.id).slice(0,12);
    const official={TB:'TBL',LA:'LAK',SJ:'SJS',NJ:'NJD',WSH:'WSH',UTAH:'UTA'};
    return {id:String(t.id), abbreviation:official[abbreviation] || abbreviation, name:String(t.displayName || t.name || t.abbreviation).slice(0,100)};
  }
  function normalizeEvent(event) {
    const c=event.competitions?.[0];
    if (!c) return null;
    const away=c.competitors?.find(t=>t.homeAway==='away');
    const home=c.competitors?.find(t=>t.homeAway==='home');
    if (!away?.team?.id || !home?.team?.id || !event.id || !Number.isFinite(Date.parse(c.date || event.date))) return null;
    const status=c.status || event.status;
    const type=status?.type || {};
    const name=String(type.name || '');
    const scoreValue=x => x === undefined || x === null || x === '' ? null : Number(typeof x==='object' ? x.value : x);
    const a=scoreValue(away.score), h=scoreValue(home.score);
    const final=type.completed===true && type.state==='post' && Number.isInteger(a) && Number.isInteger(h) && a!==h && !/CANCEL|POSTPON/i.test(name);
    const state=final ? 'final' : /CANCEL/i.test(name) ? 'canceled' : /POSTPON/i.test(name) ? 'postponed' : type.state==='in' ? 'live' : 'scheduled';
    const startTime=new Date(c.date || event.date).toISOString();
    return {gameId:String(event.id), startTime, date:dateKey(startTime), season:Number(event.season?.year || seasonFor(dateKey(startTime))), seasonType:Number(event.season?.type || event.seasonType?.type || 2), away:normalizeTeam(away.team), home:normalizeTeam(home.team), status:state, timeValid:c.timeValid!==false && event.timeValid!==false, detail:String(type.shortDetail || type.description || ''), score:(final || state==='live') && Number.isInteger(a) && Number.isInteger(h) ? {away:a,home:h} : null, winnerTeamId:final ? String(a>h ? away.team.id : home.team.id) : null};
  }
  async function request(path,base=API) {
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch(`${base}${path}`, {signal:controller.signal,credentials:'omit'});
      if (!response.ok) throw new Error(`Schedule service returned ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  async function pool(items, worker, concurrency=4) {
    let index=0;
    const results=[];
    await Promise.all(Array.from({length:Math.min(concurrency,items.length)}, async()=> {
      while(index<items.length) { const i=index++; try { results[i]={ok:true,value:await worker(items[i])}; } catch(error) { results[i]={ok:false,error}; } }
    }));
    return results;
  }

  // Persist every prediction without an expiry. Derived totals are never stored.
  function chooseRecord(a,b) {
    if (!a) return b;
    if (!b) return a;
    if (a.status==='final' && b.status!=='final') return a;
    if (b.status==='final' && a.status!=='final') return b;
    return Date.parse(b.updatedAt)>Date.parse(a.updatedAt) ? b : a;
  }
  function mergeProfiles(a,b) {
    const entries=new Map(a.predictions.map(p=>[p.gameId,p]));
    for(const p of b.predictions) entries.set(p.gameId,chooseRecord(entries.get(p.gameId),p));
    const user=Date.parse(b.usernameUpdatedAt)>Date.parse(a.usernameUpdatedAt) ? b : a;
    const appearance=Date.parse(b.themeUpdatedAt || 0)>Date.parse(a.themeUpdatedAt || 0) ? b : a;
    return {schemaVersion:1,username:user.username,usernameUpdatedAt:user.usernameUpdatedAt,theme:appearance.theme || 'light',themeUpdatedAt:appearance.themeUpdatedAt || '1970-01-01T00:00:00.000Z',predictions:[...entries.values()]};
  }
  function dbRead() {
    return new Promise((resolve,reject)=> {
      const req=db.transaction('data').objectStore('data').get('profile');
      req.onsuccess=()=>resolve(req.result || emptyProfile()); req.onerror=()=>reject(req.error);
    });
  }
  async function openStorage() {
    try {
      db=await new Promise((resolve,reject)=> {
        const req=indexedDB.open(DB_NAME,1);
        req.onupgradeneeded=()=>req.result.createObjectStore('data');
        req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
        req.onblocked=()=>reject(new Error('Storage is open in another tab'));
      });
      profile=validateProfile(await dbRead()); storageMode='indexeddb';
      db.onversionchange=()=> { db.close(); storageMode='memory'; notice('Local storage was changed in another tab. Export your data, then reload.'); };
    } catch(error) {
      // Do not overwrite an unreadable database or backup with an empty profile.
      try {
        const raw=localStorage.getItem(LOCAL_KEY);
        profile=raw ? validateProfile(JSON.parse(raw)) : emptyProfile();
        localStorage.setItem(`${LOCAL_KEY}-check`,'1'); localStorage.removeItem(`${LOCAL_KEY}-check`);
        storageMode='local';
        notice('Using limited browser storage. Export JSON regularly to keep a backup.');
      } catch { storageMode='memory'; notice('This browser cannot save local data. Predictions work for this visit; export JSON before closing.'); }
    }
    try { channel=new BroadcastChannel(DB_NAME); channel.onmessage=async()=> {
      try { const other=storageMode==='indexeddb' ? await dbRead() : JSON.parse(localStorage.getItem(LOCAL_KEY)); if(other) { profile=mergeProfiles(profile,validateProfile(other)); renderAll(); } } catch { /* Keep the current in-memory history. */ }
    }; } catch { /* Older browsers still save normally. */ }
  }
  function saveProfile() {
    saveQueue=saveQueue.catch(()=>{}).then(async()=> {
      try {
        if(storageMode==='indexeddb') {
          await new Promise((resolve,reject)=> {
            const tx=db.transaction('data','readwrite'), store=tx.objectStore('data'), req=store.get('profile');
            req.onsuccess=()=> { try { profile=mergeProfiles(validateProfile(req.result || emptyProfile()),profile); store.put(profile,'profile'); } catch(e) { tx.abort(); reject(e); } };
            tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error || new Error('Save interrupted'));
          });
        } else if(storageMode==='local') {
          const raw=localStorage.getItem(LOCAL_KEY);
          if(raw) profile=mergeProfiles(validateProfile(JSON.parse(raw)),profile);
          localStorage.setItem(LOCAL_KEY,JSON.stringify(profile));
        } else throw new Error('Local storage unavailable');
        channel?.postMessage('saved');
        return true;
      } catch { notice('Your latest changes could not be saved on this device. Export JSON now to keep them, and free browser storage before reloading.'); return false; }
    });
    return saveQueue;
  }
  const predictionFor = id => profile.predictions.find(p=>p.gameId===id);
  const completed = p => p.status==='final' && p.score && p.winnerTeamId && ['correct','incorrect'].includes(p.result);
  function settle(p) {
    p.result=p.selectedTeamId && p.status==='final' && p.winnerTeamId ? (p.selectedTeamId===p.winnerTeamId ? 'correct':'incorrect') : 'pending';
    p.streakBreaks=[];
    if(p.result==='correct' && p.streaksVerified) {
      for(const side of ['away','home']) {
        const s=p.pregameStreaks?.[side];
        if(s?.count>=4 && ((s.type==='W' && p[side].id!==p.winnerTeamId) || (s.type==='L' && p[side].id===p.winnerTeamId))) {
          p.streakBreaks.push({teamId:p[side].id,abbreviation:p[side].abbreviation,type:s.type,count:s.count});
        }
      }
    }
    return p;
  }
  function updatePrediction(game) {
    const p=predictionFor(game.gameId);
    if(!p || (p.status==='final' && game.status!=='final')) return false;
    const previous=JSON.stringify(p);
    const snapshot=p.pregameStreaks, verified=p.streaksVerified;
    Object.assign(p,game,{pregameStreaks:snapshot,streaksVerified:verified});
    if(!p.lockedAt && (Date.now()>=Date.parse(p.startTime) || ['live','final'].includes(p.status))) p.lockedAt=isoNow();
    settle(p);
    if(JSON.stringify(p)!==previous) { p.updatedAt=isoNow(); return true; }
    return false;
  }
  function canPick(game) {
    return game.status==='scheduled' && game.timeValid && Date.now()<Date.parse(game.startTime) && !predictionFor(game.gameId)?.lockedAt && Date.now()-(dayFetched.get(game.date)||0)<120000;
  }
  async function pick(id,teamId) {
    const game=games.get(id);
    if(!game || !canPick(game)) { renderSchedule(); return; }
    closeTeamPopover();
    let p=predictionFor(id);
    if(p) {
      // A null selection records a cleared pick so an older saved copy cannot
      // restore it during a merge. It never counts as a completed prediction.
      p.selectedTeamId=p.selectedTeamId===teamId ? null : teamId;
      clearedHighlight=p.selectedTeamId===null ? {gameId:id,teamId} : null;
      p.updatedAt=new Date(Math.max(Date.now(),Date.parse(p.updatedAt)+1)).toISOString();
    }
    else { clearedHighlight=null; p={...game, selectedTeamId:teamId,createdAt:isoNow(),updatedAt:isoNow(),lockedAt:null,result:'pending',pregameStreaks:{away:null,home:null},streaksVerified:false,streakBreaks:[]}; profile.predictions.push(p); }
    renderAll();
    await saveProfile();
    enrichStreaks([game]).catch(()=>{});
  }

  async function teamSeason(teamId,season,seasonType) {
    // Regular-season streaks carry into the playoffs, but not the next season.
    const types=seasonType===1 ? [1] : seasonType===3 ? [2,3] : [2];
    const key=`${teamId}:${season}:${types.join(',')}`;
    if(teamCache.has(key) && Date.now()-teamCache.get(key).at<240000) return teamCache.get(key).events;
    if(teamRequests.has(key)) return teamRequests.get(key);
    const pending=(async()=> {
      const events=new Map();
      for(const type of types) {
        const response=await request(`/teams/${encodeURIComponent(teamId)}/schedule?season=${season}&seasontype=${type}`);
        if(!Array.isArray(response.events)) throw new Error('Team schedule unavailable');
        for(const event of response.events) { const game=normalizeEvent(event); if(game && game.season===season) events.set(game.gameId,game); }
      }
      const list=[...events.values()].sort((a,b)=>Date.parse(b.startTime)-Date.parse(a.startTime));
      teamCache.set(key,{at:Date.now(),events:list});
      return list;
    })();
    teamRequests.set(key,pending);
    try { return await pending; } finally { teamRequests.delete(key); }
  }
  function normalizeStandings(response,season) {
    const entries=response.standings?.entries;
    const year=Number(response.season?.year || response.standings?.season);
    if(year!==season || !Array.isArray(entries) || entries.length<2 || response.children?.length) throw new Error('League standings unavailable');
    const teams=new Map();
    for(const [index,entry] of entries.entries()) {
      const points=entry.stats?.find(s=>s.name==='points')?.value;
      const played=entry.stats?.find(s=>s.name==='gamesPlayed')?.value;
      const id=String(entry.team?.id || '');
      if(!/^\d+$/.test(id) || teams.has(id) || !Number.isInteger(points) || points<0 || !Number.isInteger(played) || played<0) throw new Error('Incomplete league standings');
      // The level=1 endpoint is the league table in ESPN's standings order.
      // Conference playoffSeed values are not overall NHL rankings.
      teams.set(id,{position:index+1,points,played});
    }
    return {teams,total:teams.size,hasPlayed:[...teams.values()].some(t=>t.played>0),at:Date.now()};
  }
  async function leagueStandings(season) {
    const cached=standingsCache.get(season);
    if(cached && Date.now()-cached.at<300000) return cached;
    if(standingsRequests.has(season)) return standingsRequests.get(season);
    const pending=(async()=> {
      try {
        const response=await request(`/standings?season=${season}&type=0&level=1`,STANDINGS_API);
        const table=normalizeStandings(response,season);
        standingsCache.set(season,table); return table;
      } catch(error) { if(cached) return cached; throw error; }
    })();
    standingsRequests.set(season,pending);
    try { return await pending; } finally { standingsRequests.delete(season); }
  }
  function streakBefore(events,game,teamId) {
    const cutoff=Math.min(Date.parse(game.startTime),Date.now());
    let type=null,count=0;
    for(const event of events) {
      if(event.gameId===game.gameId || Date.parse(event.startTime)>=cutoff || ['canceled','postponed'].includes(event.status)) continue;
      if(event.status!=='final') {
        if(game.status!=='final' && event.status==='live') continue; // An ongoing game has not changed the current streak yet.
        return null; // Never bridge a missing result when verifying a completed game.
      }
      const next=event.winnerTeamId===teamId ? 'W':'L';
      if(type && type!==next) break;
      type=next; count++;
    }
    return count ? {type,count} : {type:'',count:0};
  }
  async function enrichStreaks(list) {
    let changed=false;
    await pool(list,async game=> {
      const [awayEvents,homeEvents]=await Promise.all([teamSeason(game.away.id,game.season,game.seasonType),teamSeason(game.home.id,game.season,game.seasonType)]);
      // An empty or incomplete response cannot establish a team's streak.
      const away=awayEvents.some(e=>e.gameId===game.gameId) ? streakBefore(awayEvents,game,game.away.id) : null;
      const home=homeEvents.some(e=>e.gameId===game.gameId) ? streakBefore(homeEvents,game,game.home.id) : null;
      const visible=games.get(game.gameId);
      if(visible) visible.pregameStreaks={away,home};
      const p=predictionFor(game.gameId);
      if(p?.selectedTeamId && (p.status!=='final' || !p.streaksVerified)) {
        // Final results use the streak immediately before that game, not at pick time.
        p.pregameStreaks={away,home};
        p.streaksVerified=p.status==='final' && away!==null && home!==null;
        settle(p); p.updatedAt=isoNow(); changed=true;
      }
    },3);
    if(changed) await saveProfile();
    renderAll();
  }
  async function loadWeek() {
    const generation=++weekGeneration, target=week;
    loading=true; renderSchedule();
    const days=Array.from({length:7},(_,i)=>addDays(target,i));
    const results=await pool(days,async day=> {
      const response=await request(`/scoreboard?dates=${day.replaceAll('-','')}&limit=100`);
      if(!Array.isArray(response.events)) throw new Error('Schedule unavailable');
      return {day,normalized:response.events.map(normalizeEvent).filter(Boolean)};
    });
    let changed=false;
    for(const result of results) {
      if(!result.ok) continue;
      const {day,normalized}=result.value;
      for(const game of normalized) changed=updatePrediction(game)||changed;
      if(generation!==weekGeneration) continue;
      for(const game of normalized) {
        const previous=games.get(game.gameId);
        if(previous?.pregameStreaks) game.pregameStreaks=previous.pregameStreaks;
      }
      // A day is only called empty after a successful response.
      for(const [id,game] of games) if(game.date===day) games.delete(id);
      for(const game of normalized) games.set(game.gameId,game);
      loadedDays.add(day); dayFetched.set(day,Date.now());
    }
    if(changed) await saveProfile();
    if(generation!==weekGeneration) return;
    loading=false; lastRefresh=new Date();
    const failed=results.filter(r=>!r.ok).length;
    $('schedule-status').dataset.failed=String(failed);
    renderAll();
    await enrichStreaks([...games.values()].filter(g=>days.includes(g.date)));
  }
  async function catchUp() {
    // IDs, rather than the original date, also find rescheduled games after a long absence.
    const pending=profile.predictions.filter(p=>p.selectedTeamId && ((!completed(p) && p.status!=='canceled' && Date.parse(p.startTime)<=Date.now()) || (completed(p) && !p.streaksVerified)));
    let changed=false, failed=0;
    await pool(pending,async p=> {
      let game=p;
      if(!completed(p)) {
        try {
          const response=await request(`/summary?event=${encodeURIComponent(p.gameId)}`);
          const header=response.header;
          game=header && normalizeEvent({...header,id:header.id || p.gameId,season:{year:p.season,type:p.seasonType}});
          if(!game || game.gameId!==p.gameId) throw new Error('Result unavailable');
          changed=updatePrediction(game)||changed;
          if(games.has(game.gameId)) {
            game.pregameStreaks=games.get(game.gameId).pregameStreaks;
            games.set(game.gameId,game);
          }
        } catch { failed++; return; }
      }
      if(completed(p) && !p.streaksVerified) await enrichStreaks([game]);
    },3);
    if(changed) await saveProfile();
    if(failed) $('import-status').textContent=`${failed} saved result${failed===1?' is':'s are'} still waiting for the schedule service. History is preserved; refresh to retry.`;
    renderAll();
  }
  async function refresh() {
    if(refreshRunning) return;
    refreshRunning=true; $('refresh').disabled=true;
    try { await Promise.all([loadWeek(),catchUp()]); }
    finally { refreshRunning=false; $('refresh').disabled=false; }
  }

  const statsFor = entries => {
    const all=entries.filter(completed), correct=all.filter(p=>p.result==='correct').length;
    return {correct,total:all.length,accuracy:all.length ? correct/all.length*100 : null};
  };
  function accuracyClass(s,minimumForRainbow=50) { return s.accuracy===null ? 'unavailable' : s.accuracy<50 ? 'low' : s.accuracy<60 ? 'medium' : s.accuracy>=80 && s.total>=minimumForRainbow ? 'rainbow' : 'high'; }
  const percent = s => s.accuracy===null ? '—' : `${s.accuracy.toFixed(1)}%`;
  function accuracyHTML(s,minimumForRainbow=50) { return `<span class="accuracy ${accuracyClass(s,minimumForRainbow)}">${percent(s)}</span>`; }
  function changeHTML(current,previous) {
    if(current.accuracy===null || previous?.accuracy==null) return '<span class="change neutral" aria-label="Insufficient comparison data">—</span>';
    const change=Math.round((current.accuracy-previous.accuracy)*10)/10;
    if(!change) return '<span class="change neutral" aria-label="Unchanged">—</span>';
    return `<span class="change ${change>0?'up':'down'}" aria-label="${Math.abs(change).toFixed(1)} percentage points ${change>0?'higher':'lower'}">${change>0?'↑ +':'↓ −'}${Math.abs(change).toFixed(1)}</span>`;
  }
  const predictionOrder=(a,b)=>a.startTime.localeCompare(b.startTime) || a.gameId.localeCompare(b.gameId,undefined,{numeric:true});
  const selectedTeam=p=>p.selectedTeamId===p.away.id?p.away:p.home;
  function stretchScore(correct,incorrect) {
    // Wilson lower-bound score, used only to rank past stretches by accuracy
    // and sample size. Displayed accuracy is always the actual correct / total.
    const total=correct+incorrect,z=1.96,z2=z*z;
    return total?(correct+z2/2-z*Math.sqrt(correct*incorrect/total+z2/4))/(total+z2):0;
  }
  let stretchCacheKey=null,stretchCache=null;
  function bestSustainedStretch(entries) {
    const key=entries.map(p=>p.result==='correct'?'1':'0').join('');
    if(key===stretchCacheKey) return stretchCache;
    const starts=[];
    let correct=0,incorrect=0,best=null;
    const turn=(a,b,c)=>(b.index-a.index)*(c.correct-a.correct)-(b.correct-a.correct)*(c.index-a.index);
    for(let i=0;i<entries.length;i++) {
      const right=entries[i].result==='correct';
      if(right && (i===0 || entries[i-1].result==='incorrect')) {
        const start={index:i,correct,incorrect};
        // For this score, starts above the lower hull are dominated by its
        // endpoints. Scan only hull vertices, keeping earliest collinear starts.
        while(starts.length>1 && turn(starts[starts.length-2],starts[starts.length-1],start)<=0) starts.pop();
        starts.push(start);
      }
      if(right) correct++;else incorrect++;
      // Adding a correct pick improves the score; adding an incorrect pick
      // lowers it. An optimum therefore starts and ends at complete correct runs.
      if(!right || entries[i+1]?.result==='correct') continue;
      for(const start of starts) {
        const wins=correct-start.correct,losses=incorrect-start.incorrect,length=i-start.index+1,score=stretchScore(wins,losses);
        if(!best || score>best.score+1e-12 || (Math.abs(score-best.score)<=1e-12 && (length>best.length || (length===best.length && start.index<best.start)))) {
          best={start:start.index,end:i+1,length,correct:wins,incorrect:losses,score};
        }
      }
    }
    stretchCacheKey=key;stretchCache=best;
    return best;
  }
  function personalRecords(predictions) {
    const entries=predictions.filter(completed).sort(predictionOrder), correct=entries.filter(p=>p.result==='correct');
    const records=[];
    const record=(id,title,note,games,value,detail='')=>records.push({id,title,note,games,value:games.length?value:'—',detail});
    const run=predicate=>{
      let start=0,bestStart=0,bestLength=0;
      for(let i=0;i<entries.length;i++) {
        if(!predicate(entries[i])) { start=i+1; continue; }
        if(i-start+1>bestLength) { bestStart=start; bestLength=i-start+1; }
      }
      return entries.slice(bestStart,bestStart+bestLength);
    };
    for(const [id,title,result] of [['correct-run','Longest correct streak','correct'],['incorrect-run','Longest incorrect streak','incorrect']]) {
      const games=run(p=>p.result===result);
      record(id,title,'Consecutive completed predictions, across all seasons.',games,`${games.length} in a row`);
    }
    const days=new Map(),weeks=new Map(),teams=new Map();
    for(const p of entries) {
      for(const [map,key] of [[days,p.date],[weeks,monday(p.date)]]) { if(!map.has(key)) map.set(key,[]); map.get(key).push(p); }
      for(const team of [p.away,p.home]) { if(!teams.has(team.id)) teams.set(team.id,{team,games:[]}); teams.get(team.id).games.push(p); }
    }
    const betterPeriod=(games,best)=>{
      const s=statsFor(games),b=statsFor(best);
      return !best.length || s.correct*best.length>b.correct*games.length || (s.correct*best.length===b.correct*games.length && games.length>best.length);
    };
    for(const [id,title,map,minimum] of [['best-day','Best prediction day',days,3],['best-week','Best prediction week',weeks,5]]) {
      let best=[];
      for(const games of map.values()) if(games.length>=minimum && betterPeriod(games,best)) best=games;
      const s=statsFor(best);
      record(id,title,`Highest accuracy with at least ${minimum} completed picks. Ties favour more games, then the earliest period.`,best,`${percent(s)} · ${s.correct} / ${s.total}`);
    }
    let rollingCorrect=0,bestRolling=-1,rollingEnd=-1;
    for(let i=0;i<entries.length;i++) {
      rollingCorrect+=Number(entries[i].result==='correct');
      if(i>=10) rollingCorrect-=Number(entries[i-10].result==='correct');
      if(i>=9 && rollingCorrect>bestRolling) { bestRolling=rollingCorrect; rollingEnd=i; }
    }
    record('best-ten','Best run of 10 picks','Your most correct predictions in any ten consecutive completed picks.',rollingEnd<0?[]:entries.slice(rollingEnd-9,rollingEnd+1),`${bestRolling} / 10 correct`);
    const strongest=bestSustainedStretch(entries),stretch=strongest?entries.slice(strongest.start,strongest.end):[];
    record('best-stretch','Best overall stretch','Balances accuracy with the number of completed picks to find your strongest sustained run. No fixed length or accuracy cutoff. Ties favour longer stretches, then the earliest.',stretch,strongest?`${strongest.correct} correct / ${strongest.incorrect} incorrect`:'',strongest?`${percent(statsFor(stretch))} accuracy · ${strongest.length} predictions`:'');
    let upset=null,upsetStrength=0,upsetDetail='';
    for(const p of correct) {
      if(!p.streaksVerified) continue;
      const ownSide=p.selectedTeamId===p.away.id?'away':'home',otherSide=ownSide==='away'?'home':'away';
      const own=p.pregameStreaks?.[ownSide],other=p.pregameStreaks?.[otherSide];
      const strength=(own?.type==='L'?own.count:0)+(other?.type==='W'?other.count:0);
      if(strength>=4 && strength>upsetStrength) {
        upset=p; upsetStrength=strength;
        upsetDetail=`${p[ownSide].abbreviation} ${own?.count?own.type+own.count:'—'} over ${p[otherSide].abbreviation} ${other?.count?other.type+other.count:'—'}`;
      }
    }
    record('form-upset','Biggest form upset','Largest combined pregame losing streak for your chosen team plus winning streak for its opponent (at least four combined). A form record, not a win probability.',upset?[upset]:[],upsetDetail);
    let broken=null,brokenGame=null;
    for(const p of correct) for(const streak of p.streakBreaks || []) if(!broken || streak.count>broken.count) { broken=streak; brokenGame=p; }
    record('biggest-break','Biggest streak break','Longest single team streak ended by one of your correct picks. Winning and losing streaks both count.',brokenGame?[brokenGame]:[],broken?`${broken.abbreviation} ${broken.type}${broken.count} ended`:'');
    let marginGame=null,margin=0;
    for(const p of correct) {
      const difference=Math.abs(p.score.away-p.score.home);
      if(difference>margin) { margin=difference; marginGame=p; }
    }
    record('winning-margin','Biggest winning margin','The largest final-score margin for a team you correctly picked.',marginGame?[marginGame]:[],`${margin} goal${margin===1?'':'s'}`,marginGame?`${selectedTeam(marginGame).abbreviation} won ${marginGame.score.away}–${marginGame.score.home} (${marginGame.away.abbreviation}–${marginGame.home.abbreviation})`:'');
    let bestTeam=null;
    for(const candidate of teams.values()) if(candidate.games.length>=5 && betterPeriod(candidate.games,bestTeam?.games || [])) bestTeam=candidate;
    record('best-team','Team you read best','Highest accuracy in games involving a team, whether you picked for or against it. At least five completed picks; ties favour more games.',bestTeam?.games || [],bestTeam?`${bestTeam.team.abbreviation} · ${percent(statsFor(bestTeam.games))}`:'');
    let perfectStart=0,perfectBestStart=0,perfectLength=0,perfectBestLength=0,previousDate=null;
    const dayEntries=[...days.entries()];
    for(let i=0;i<dayEntries.length;i++) {
      const [date,games]=dayEntries[i];
      if(games.some(p=>p.result!=='correct')) { perfectLength=0; previousDate=null; continue; }
      if(!previousDate || addDays(previousDate,1)!==date) { perfectStart=i; perfectLength=0; }
      perfectLength++; previousDate=date;
      if(perfectLength>perfectBestLength) { perfectBestStart=perfectStart; perfectBestLength=perfectLength; }
    }
    const perfectGames=dayEntries.slice(perfectBestStart,perfectBestStart+perfectBestLength).flatMap(([,games])=>games);
    record('perfect-days','Longest perfect-day run','Consecutive Eastern Time dates with at least one completed pick and every pick correct. A missed date breaks this run.',perfectGames,`${perfectBestLength} perfect day${perfectBestLength===1?'':'s'}`);
    return records;
  }
  function recordTimestamp(games) {
    if(!games.length) return '';
    const format=p=>new Intl.DateTimeFormat('en-US',{timeZone:ZONE,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(p.startTime));
    return `${format(games[0])}${games.length>1?` – ${format(games[games.length-1])}`:''} ET`;
  }
  function nhlGameLink(game,label='View game on NHL.com') {
    // ESPN and NHL use different game IDs. The official date page is a stable,
    // browser-only route to the matchup, recap and available highlights.
    return `<a class="game-link" href="https://www.nhl.com/scores/${game.date}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHTML(label)}: ${escapeHTML(game.away.name)} at ${escapeHTML(game.home.name)}, ${game.date}. Opens this date's scores in a new tab.">${escapeHTML(label)} <span aria-hidden="true">↗</span></a>`;
  }
  function logoURL(team) { return `https://assets.nhle.com/logos/nhl/svg/${encodeURIComponent(team.abbreviation)}_${profile.theme==='dark'?'dark':'light'}.svg`; }
  function pickedTeamHTML(team) {
    return `<span class="picked" aria-label="Your pick: ${escapeHTML(team.name)}"><img class="pick-logo" src="${escapeHTML(logoURL(team))}" alt="" width="25" height="25" loading="lazy" onerror="this.style.visibility='hidden'">${escapeHTML(team.abbreviation)}</span>`;
  }
  function teamHTML(team,{game=null,side='',interactive=false,selected=false}={}) {
    const expanded=openTeamDetails?.gameId===game?.gameId && openTeamDetails?.side===side;
    const logo=`<button type="button" class="team-info" aria-label="${escapeHTML(team.name)} details" aria-haspopup="dialog" aria-controls="team-popover" aria-expanded="${expanded}"><img src="${escapeHTML(logoURL(team))}" alt="" width="25" height="25" loading="lazy" onerror="this.style.visibility='hidden'"></button>`;
    const label=interactive ? `<button class="team interactive${selected?' selected':''}" data-game="${game.gameId}" data-team="${escapeHTML(team.id)}" aria-label="Predict ${escapeHTML(team.name)} to win" aria-pressed="${selected}">${escapeHTML(team.abbreviation)}</button>` : `<span class="team${selected?' selected':''}">${escapeHTML(team.abbreviation)}</span>`;
    const cleared=clearedHighlight?.gameId===game?.gameId && clearedHighlight?.teamId===team.id;
    return `<span class="team-entry${selected?' is-selected':''}${cleared?' just-cleared':''}" data-game-id="${game?.gameId || ''}" data-team-id="${escapeHTML(team.id)}" data-side="${side}">${logo}${label}</span>`;
  }
  function closeTeamPopover(restoreFocus=false) {
    clearTimeout(popoverTimer); clearTimeout(hoverTimer); popoverRequest++;
    const anchor=openTeamDetails?.anchor;
    openTeamDetails=null; $('team-popover').hidden=true;
    anchor?.setAttribute('aria-expanded','false');
    if(restoreFocus && anchor?.isConnected) {
      suppressPopoverFocus=true; anchor.focus({preventScroll:true}); suppressPopoverFocus=false;
    }
  }
  function positionTeamPopover() {
    if(!openTeamDetails) return;
    const popup=$('team-popover'), anchor=openTeamDetails.anchor;
    if(!anchor.isConnected) { closeTeamPopover(); return; }
    const viewport=window.visualViewport;
    const width=viewport?.width || innerWidth, height=viewport?.height || innerHeight;
    const offsetLeft=viewport?.offsetLeft || 0, offsetTop=viewport?.offsetTop || 0;
    popup.style.width=`${Math.min(350,width-24)}px`;
    popup.style.maxHeight=`${height-24}px`;
    const rect=anchor.closest('.team-entry').getBoundingClientRect();
    const above=rect.top-offsetTop-21, below=offsetTop+height-rect.bottom-21;
    const placeBelow=below>=above;
    // Keep the trigger uncovered even when the added standings make the
    // popover taller. Small screens can scroll the details internally.
    popup.style.maxHeight=`${Math.min(height-24,Math.max(80,placeBelow?below:above))}px`;
    const box=popup.getBoundingClientRect();
    const left=Math.max(offsetLeft+12,Math.min(rect.left,offsetLeft+width-box.width-12));
    const top=placeBelow ? rect.bottom+9 : Math.max(offsetTop+12,rect.top-box.height-9);
    popup.style.left=`${left}px`; popup.style.top=`${top}px`;
  }
  function popoverStats(events,game,side) {
    const team=game[side], cutoff=Math.min(Date.parse(game.startTime),Date.now());
    const finished=events.filter(e=>e.status==='final' && e.gameId!==game.gameId && Date.parse(e.startTime)<cutoff);
    const streak=streakBefore(events,game,team.id);
    const recent=finished.slice(0,5), wins=finished.filter(e=>e.winnerTeamId===team.id).length;
    const scores=recent.filter(e=>e.score);
    const goals=(own)=>scores.length ? (scores.reduce((sum,e)=>sum+e.score[(e.away.id===team.id)===own?'away':'home'],0)/scores.length).toFixed(1) : '—';
    const streakText=streak?.count ? `${streak.type}${streak.count} · ${streak.count} straight ${streak.type==='W'?(streak.count===1?'win':'wins'):(streak.count===1?'loss':'losses')}` : streak?.count===0 ? 'No completed games yet' : 'Unavailable';
    const latest=recent[0], opponent=latest && (latest.away.id===team.id?latest.home:latest.away);
    const ownScore=latest && latest.score[latest.away.id===team.id?'away':'home'];
    const opponentScore=latest && latest.score[latest.away.id===team.id?'home':'away'];
    const recentResults=recent.map(event=>{
      const opponent=event.away.id===team.id?event.home:event.away;
      const won=event.winnerTeamId===team.id;
      return `<span class="${won?'result-correct':'result-incorrect'}"><img src="${escapeHTML(logoURL(opponent))}" alt="${won?'Won against':'Lost to'} ${escapeHTML(opponent.name)}" width="24" height="24"></span>`;
    }).join(' ');
    return {
      stats:`<dl class="popover-stats"><div><dt>Wins / losses</dt><dd>${finished.length ? `${wins} / ${finished.length-wins}` : '—'}</dd></div><div><dt>Streak</dt><dd class="popover-streak ${streak?.type==='W'?'win':streak?.type==='L'?'loss':''}">${streakText}</dd></div><div><dt>Last ${recent.length || 5}</dt><dd class="recent-results">${recentResults || '—'}</dd></div><div><dt>Goals/game · last ${recent.length || 5}</dt><dd>${goals(true)} / ${goals(false)}</dd></div></dl>`,
      lastGame:latest ? `<p class="popover-last">Last game: <span class="${latest.winnerTeamId===team.id?'result-correct':'result-incorrect'}">${latest.winnerTeamId===team.id?'W':'L'} ${ownScore}–${opponentScore}</span> vs ${escapeHTML(opponent.abbreviation)} <span class="quiet">(${formatDay(latest.date,{month:'short',day:'numeric'})})</span></p>`:''
    };
  }
  async function renderTeamStandings(game,team,token) {
    const container=$('team-popover-standings');
    const rows=(rank,points)=>`<dl class="popover-stats"><div><dt>League position</dt><dd>${rank}</dd></div><div><dt>Standings points</dt><dd>${points}</dd></div></dl>`;
    renderMarkup(container,rows('Loading…','—'));
    try {
      const table=await leagueStandings(game.season);
      if(token!==popoverRequest) return;
      const entry=table.teams.get(team.id);
      if(!entry) throw new Error('Team not found in league table');
      const label=game.season<seasonFor(today())?'Final':'Latest';
      renderMarkup(container,rows(table.hasPlayed?`${entry.position} / ${table.total}`:'Not ranked yet',`${entry.points} · ${entry.played} GP`));
      container.setAttribute('aria-label',`${label} ${seasonLabel(game.season)} regular-season standings`);
    } catch {
      if(token!==popoverRequest) return;
      renderMarkup(container,rows('Unavailable','—')+'<p class="popover-note quiet">Standings are unavailable right now. Close and reopen to retry.</p>');
    }
    positionTeamPopover();
  }
  async function showTeamPopover(entry,mode='hover') {
    clearTimeout(popoverTimer);
    const gameId=entry.dataset.gameId, side=entry.dataset.side;
    const game=activePage==='history' ? predictionFor(gameId) : games.get(gameId) || predictionFor(gameId);
    if(!game || !['away','home'].includes(side)) return;
    const anchor=entry.querySelector('.team-info');
    if(openTeamDetails?.anchor===anchor) { if(mode==='click') openTeamDetails.mode='click'; positionTeamPopover(); return; }
    closeTeamPopover();
    const token=++popoverRequest, team=game[side];
    openTeamDetails={gameId,side,anchor,mode};
    anchor.setAttribute('aria-expanded','true');
    $('team-popover-name').textContent=team.name;
    $('team-popover-season').textContent=`${seasonLabel(game.season)} · ${team.abbreviation}`;
    $('team-popover-logo').src=logoURL(team);
    const slug=Object.hasOwn(PUCKALYTICS_TEAMS,team.abbreviation)?PUCKALYTICS_TEAMS[team.abbreviation]:null, link=$('team-popover-link');
    link.hidden=!slug;
    if(slug) {
      link.href=`https://www.puckalytics.com/teams/${slug}`;
      link.setAttribute('aria-label',`View ${team.name} on Puckalytics (opens in a new tab)`);
    } else link.removeAttribute('href');
    $('team-popover-content').innerHTML='<p class="popover-note quiet">Loading team results…</p>';
    $('team-popover-content').renderedHTML=null;
    renderMarkup($('team-popover-last'),'');
    $('team-popover').hidden=false;
    renderTeamStandings(game,team,token);
    positionTeamPopover();
    try {
      const events=await teamSeason(team.id,game.season,game.seasonType);
      if(token!==popoverRequest) return;
      if(!events.some(e=>e.gameId===gameId)) throw new Error('Incomplete team schedule');
      const details=popoverStats(events,game,side);
      renderMarkup($('team-popover-content'),details.stats);
      renderMarkup($('team-popover-last'),details.lastGame);
    } catch {
      if(token!==popoverRequest) return;
      const streak=game.pregameStreaks?.[side];
      $('team-popover-content').innerHTML=`<p class="popover-note">${streak?.count ? `Saved pregame streak: ${streak.type}${streak.count}. `:''}Team results are unavailable right now. Close and reopen to retry.</p>`;
      $('team-popover-content').renderedHTML=null;
    }
    positionTeamPopover();
  }
  function setupTeamPopovers() {
    const popup=$('team-popover');
    const deferClose=()=> {
      clearTimeout(popoverTimer);
      if(openTeamDetails?.mode==='click') return;
      popoverTimer=setTimeout(()=> {
        if(!popup.contains(document.activeElement) && document.activeElement!==openTeamDetails?.anchor) closeTeamPopover();
      },180);
    };
    document.addEventListener('pointerover',event=> {
      const entry=event.target.closest('.team-entry');
      if(event.pointerType!=='touch' && entry && !entry.contains(event.relatedTarget)) {
        clearTimeout(hoverTimer); clearTimeout(popoverTimer);
        hoverTimer=setTimeout(()=> { if(entry.isConnected && entry.matches(':hover')) showTeamPopover(entry); },500);
      }
    });
    document.addEventListener('pointerout',event=> {
      const entry=event.target.closest('.team-entry');
      if(entry && !entry.contains(event.relatedTarget)) {
        clearTimeout(hoverTimer);
        if(clearedHighlight?.gameId===entry.dataset.gameId && clearedHighlight?.teamId===entry.dataset.teamId) {
          clearedHighlight=null; entry.classList.remove('just-cleared');
        }
        if(!popup.contains(event.relatedTarget)) deferClose();
      }
    });
    popup.addEventListener('pointerenter',()=> { clearTimeout(popoverTimer); clearTimeout(hoverTimer); });
    popup.addEventListener('pointerleave',deferClose);
    document.addEventListener('focusin',event=> {
      if(!suppressPopoverFocus && event.target.matches('.team-info:focus-visible')) showTeamPopover(event.target.closest('.team-entry'),'focus');
    });
    document.addEventListener('focusout',event=> {
      if(openTeamDetails && !popup.contains(event.relatedTarget) && !openTeamDetails.anchor.closest('.team-entry').contains(event.relatedTarget)) {
        if(event.relatedTarget && !popup.contains(event.relatedTarget)) closeTeamPopover();
        else deferClose();
      }
    });
    document.addEventListener('click',event=> {
      const info=event.target.closest('.team-info');
      if(info) {
        if(openTeamDetails?.anchor===info && openTeamDetails.mode==='click') closeTeamPopover();
        else showTeamPopover(info.closest('.team-entry'),'click');
      } else if(!popup.contains(event.target)) closeTeamPopover();
    });
    $('close-team-popover').addEventListener('click',()=>closeTeamPopover(true));
    document.addEventListener('keydown',event=> { if(event.key==='Escape' && openTeamDetails) { event.preventDefault(); closeTeamPopover(true); } });
    window.addEventListener('resize',positionTeamPopover);
    document.addEventListener('scroll',event=> { if(!popup.contains(event.target)) closeTeamPopover(); },true);
  }
  function renderTheme() {
    document.documentElement.dataset.theme=profile.theme;
    document.querySelector('meta[name="theme-color"]').content=profile.theme==='dark'?'#1a1a1a':'#f5f6f8';
    $('theme-toggle').setAttribute('aria-pressed',String(profile.theme==='dark'));
    $('theme-toggle').textContent=`Dark mode: ${profile.theme==='dark'?'On':'Off'}`;
    if(openTeamDetails) {
      const game=games.get(openTeamDetails.gameId) || predictionFor(openTeamDetails.gameId);
      if(game) $('team-popover-logo').src=logoURL(game[openTeamDetails.side]);
    }
    try { localStorage.setItem('nhl-colour-theme',profile.theme); } catch { /* IndexedDB remains the primary profile store. */ }
  }
  function renderHeader() {
    const s=statsFor(profile.predictions);
    $('header-points').textContent=s.correct;
    $('header-accuracy').textContent=percent(s); $('header-accuracy').className=`accuracy ${accuracyClass(s)}`;
    $('header-username').textContent=profile.username; $('header-username').hidden=!profile.username;
    $('profile-points').textContent=s.correct;
    $('profile-breaks').textContent=profile.predictions.filter(completed).reduce((sum,p)=>sum+(p.streakBreaks?.length || 0),0);
  }
  function renderSchedule() {
    const end=addDays(week,6), sameMonth=week.slice(0,7)===end.slice(0,7);
    $('week-label').textContent=sameMonth ? `${formatDay(week,{month:'long',day:'numeric'})}–${Number(end.slice(8,10))}, ${end.slice(0,4)}` : `${formatDay(week,{month:'short',day:'numeric',year:'numeric'})} – ${formatDay(end,{month:'short',day:'numeric',year:'numeric'})}`;
    const list=[...games.values()].filter(g=>g.date>=week && g.date<=end).sort((a,b)=>Date.parse(a.startTime)-Date.parse(b.startTime));
    $('upcoming-count').textContent=list.filter(g=>g.status!=='final').length;
    $('final-count').textContent=list.filter(g=>g.status==='final').length;
    $('upcoming-tab').setAttribute('aria-pressed',gameFilter==='upcoming'); $('final-tab').setAttribute('aria-pressed',gameFilter==='final');
    const failure=Number($('schedule-status').dataset.failed || 0);
    $('schedule-page').setAttribute('aria-busy',String(loading));
    const hasSchedule=Array.from({length:7},(_,i)=>addDays(week,i)).some(day=>loadedDays.has(day));
    if(!loading || !hasSchedule) $('schedule-status').textContent=loading ? 'Updating schedule…' : failure ? 'Some dates could not refresh. Cached games remain visible. Refresh to retry.' : lastRefresh ? `Updated ${new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:ZONE}).format(lastRefresh)} ET · Updates every minute while open` : 'Loading schedule…';
    let html='';
    for(let i=0;i<7;i++) {
      const date=addDays(week,i), all=list.filter(g=>g.date===date), filtered=all.filter(g=>gameFilter==='final' ? g.status==='final' : g.status!=='final');
      html+=`<tr class="date-row" data-row-key="date-${date}"><th colspan="3" scope="rowgroup">${formatDay(date,{weekday:'long',month:'long',day:'numeric'})}</th></tr>`;
      if(!filtered.length) {
        const text=!loadedDays.has(date) ? (loading?'Loading games…':'Schedule unavailable. Refresh to retry.') : !all.length ? 'No games scheduled' : gameFilter==='final' ? 'No completed games' : 'All games final — see Final';
        html+=`<tr class="empty-row" data-row-key="empty-${date}"><td colspan="3">${text}</td></tr>`; continue;
      }
      for(const game of filtered) {
        const p=predictionFor(game.gameId), selected=p?.selectedTeamId, interactive=canPick(game);
        const time=game.status==='final' ? escapeHTML(game.detail || 'Final') : game.status==='live' ? `Live<small>${escapeHTML(game.detail)}</small>` : game.status==='postponed' ? 'Postponed' : game.status==='canceled' ? 'Canceled' : !game.timeValid ? 'TBD' : new Intl.DateTimeFormat('en-US',{timeZone:ZONE,hour:'numeric',minute:'2-digit'}).format(new Date(game.startTime));
        const team=selected===game.away.id ? game.away : game.home;
        const pickText=selected ? `${pickedTeamHTML(team)}${completed(p) ? `<small class="result-${p.result}">${p.result==='correct'?'Correct':'Incorrect'}${p.streakBreaks.length?' · Streak Break':''}</small>` : !interactive ? '<small>Locked</small>':''}` : 'Unpicked';
        html+=`<tr class="${p && completed(p)?`prediction-${p.result}`:''}" data-row-key="game-${game.gameId}"><td class="game-time">${time}${game.status==='final'?`<small>${nhlGameLink(game,'NHL.com')}</small>`:''}</td><td><div class="matchup"><div class="matchup-teams">${teamHTML(game.away,{game,side:'away',interactive,selected:selected===game.away.id})}<span class="at">at</span>${teamHTML(game.home,{game,side:'home',interactive,selected:selected===game.home.id})}</div>${game.score?`<span class="score">${game.score.away}–${game.score.home}</span>`:''}</div></td><td class="pick-cell">${pickText}</td></tr>`;
      }
    }
    renderMarkup($('schedule-body'),html);
  }
  function renderHistorySeasons() {
    const previous=$('history-season').value;
    const seasons=[...new Set(profile.predictions.map(p=>p.season))].sort((a,b)=>b-a);
    renderMarkup($('history-season'),'<option value="">All seasons</option>'+seasons.map(s=>`<option value="${s}">${seasonLabel(s)}</option>`).join(''));
    $('history-season').value=previous;
  }
  function renderHistory() {
    renderHistorySeasons();
    const year=$('history-season').value,from=$('history-from').value,to=$('history-to').value;
    const selectedIds=historySelection?new Set(historySelection.games.map(p=>p.gameId)):null;
    const entries=profile.predictions.filter(p=>completed(p) && (!selectedIds || selectedIds.has(p.gameId)) && (!year || p.season===Number(year)) && (!from || p.date>=from) && (!to || p.date<=to)).sort((a,b)=>predictionOrder(b,a));
    $('history-record').hidden=!historySelection;
    $('history-record-label').textContent=historySelection?`${historySelection.title} · ${historySelection.value} · ${recordTimestamp(historySelection.games)}`:'';
    const s=statsFor(entries), pending=profile.predictions.filter(p=>p.selectedTeamId && !completed(p) && p.status!=='canceled').length;
    $('history-summary').textContent=`${entries.length} completed prediction${entries.length===1?'':'s'}${entries.length?` · ${s.correct} correct · ${percent(s)} accuracy`:''}${pending?` · ${pending} awaiting results`:''}`;
    const html=entries.length ? entries.map(p=> {
      const team=p.selectedTeamId===p.away.id?p.away:p.home;
      const breaks=p.streakBreaks.length ? `<span class="streak-break" title="${escapeHTML(p.streakBreaks.map(s=>`${s.abbreviation} ${s.type}${s.count} ended`).join('; '))}">Streak Break${p.streakBreaks.length>1?` ×${p.streakBreaks.length}`:''}</span>` : '';
      return `<tr id="history-game-${p.gameId}" tabindex="-1" class="prediction-${p.result}${historySelection?' record-match':''}" data-row-key="game-${p.gameId}"><td class="history-date">${formatDay(p.date,{month:'short',day:'numeric'})}<small style="display:block">${p.date.slice(0,4)}</small><small class="history-time">${new Intl.DateTimeFormat('en-US',{timeZone:ZONE,hour:'numeric',minute:'2-digit'}).format(new Date(p.startTime))} ET</small></td><td><div class="matchup"><div class="matchup-teams">${teamHTML(p.away,{game:p,side:'away'})}<span class="at">at</span>${teamHTML(p.home,{game:p,side:'home'})}</div><span class="score">${p.score.away}–${p.score.home}</span></div>${nhlGameLink(p)}</td><td>${escapeHTML(team.abbreviation)}</td><td><span class="result-${p.result}">${p.result==='correct'?'✓ Correct':'✕ Incorrect'}</span>${breaks}${!p.streaksVerified?'<small class="quiet" style="display:block">Streak check pending</small>':''}</td></tr>`;
    }).join('') : '<tr class="empty-row"><td colspan="4">No completed predictions'+(year||from||to?' match these filters.':" yet. Choose a team on the schedule to get started.")+'</td></tr>';
    renderMarkup($('history-body'),html);
  }
  function renderProfile() {
    const currentDay=today(), weekStart=monday(currentDay), monthStart=`${currentDay.slice(0,7)}-01`;
    const previousMonthEnd=addDays(monthStart,-1), previousMonthStart=`${previousMonthEnd.slice(0,7)}-01`;
    const currentSeason=seasonFor(currentDay);
    const between=(start,end)=>statsFor(profile.predictions.filter(p=>p.date>=start && p.date<=end));
    const rows=[
      ['Today',between(currentDay,currentDay),between(addDays(currentDay,-1),addDays(currentDay,-1)),{from:currentDay,to:currentDay}],
      ['This week',between(weekStart,currentDay),between(addDays(weekStart,-7),addDays(weekStart,-1)),{from:weekStart,to:currentDay}],
      [formatDay(currentDay,{month:'long'}),between(monthStart,currentDay),between(previousMonthStart,previousMonthEnd),{from:monthStart,to:currentDay}],
      [`${seasonLabel(currentSeason)} season`,statsFor(profile.predictions.filter(p=>p.season===currentSeason)),statsFor(profile.predictions.filter(p=>p.season===currentSeason-1)),{season:String(currentSeason)}],
      ['Lifetime',statsFor(profile.predictions),null,{}]
    ];
    renderMarkup($('accuracy-body'),rows.map(([label,s,previous,filters])=>`<tr><td><a class="period-link" href="#history${Object.keys(filters).length?'?'+new URLSearchParams(filters):''}">${label}</a></td><td>${s.correct}</td><td>${s.total}</td><td>${accuracyHTML(s,label==='Lifetime'?50:1)}</td><td>${previous?changeHTML(s,previous):'<span class="change neutral" aria-label="No previous lifetime period">—</span>'}</td></tr>`).join(''));
    if(document.activeElement!==$('username')) $('username').value=profile.username;
  }
  function renderStats() {
    if(activePage!=='stats') return;
    const entries=profile.predictions.filter(completed).sort(predictionOrder),last=entries[entries.length-1];
    let current=0;
    for(let i=entries.length-1;i>=0 && entries[i].result===last.result;i--) current++;
    $('stats-current').textContent=last?`${current} ${last.result}`:'—';
    $('stats-current').className=last?`result-${last.result}`:'quiet';
    const records=personalRecords(profile.predictions);
    renderMarkup($('personal-records'),records.map(r=>`<article class="personal-record" data-record="${r.id}"><div class="record-heading"><h3>${r.title}</h3><p class="record-value${r.games.length?'':' quiet'}">${escapeHTML(r.value)}</p></div><p class="record-note">${escapeHTML(r.note)}</p>${r.detail?`<p class="record-detail">${escapeHTML(r.detail)}</p>`:''}${r.games.length?`<a class="record-date" href="#history?record=${r.id}" aria-label="View ${r.title.toLowerCase()} in History: ${escapeHTML(recordTimestamp(r.games))}">${escapeHTML(recordTimestamp(r.games))} <span aria-hidden="true">→</span></a>`:'<p class="record-empty quiet">Not enough saved results yet.</p>'}${r.id==='best-stretch'?'<details class="record-method"><summary>How it is chosen</summary><p>A Wilson lower-bound score (z = 1.96) gives more weight to sustained results than to very short runs. It is used only to rank past stretches. The accuracy shown above is always correct picks divided by completed picks.</p></details>':''}</article>`).join(''));
  }
  function renderAll() { renderTheme(); renderHeader(); renderSchedule(); renderHistory(); renderProfile(); renderStats(); if(openTeamDetails) positionTeamPopover(); }

  // Whitelist every imported field, validate the entire file before merging,
  // and recompute results and distinctions instead of trusting imported totals.
  function validateProfile(input) {
    const fail=()=>{throw new Error('This is not a supported profile backup, or a prediction contains invalid data. No data was imported.');};
    if(!input || input.schemaVersion!==1 || typeof input.username!=='string' || input.username.length>40 || !Array.isArray(input.predictions)) return fail();
    const validTime=s=>typeof s==='string' && Number.isFinite(Date.parse(s));
    if(input.theme!==undefined && !['light','dark'].includes(input.theme)) return fail();
    const validId=s=>typeof s==='string' && /^\d{1,20}$/.test(s);
    const cleanTeam=t=> { if(!t || !validId(t.id) || typeof t.abbreviation!=='string' || !/^[A-Za-z0-9 .-]{1,12}$/.test(t.abbreviation) || typeof t.name!=='string' || !t.name || t.name.length>100) return fail(); return {id:t.id,abbreviation:t.abbreviation,name:t.name}; };
    const cleanStreak=s=> { if(s===null || s===undefined) return null; if(!['W','L',''].includes(s.type) || !Number.isInteger(s.count) || s.count<0 || s.count>1000 || (s.type==='' && s.count!==0) || (s.type!=='' && s.count===0)) return fail(); return {type:s.type,count:s.count}; };
    const entries=new Map();
    for(const raw of input.predictions) {
      if(!raw || !validId(raw.gameId) || !validTime(raw.startTime) || !validTime(raw.createdAt) || !validTime(raw.updatedAt) || !Number.isInteger(raw.season) || raw.season<1900 || raw.season>9999 || ![1,2,3,4].includes(raw.seasonType) || !['scheduled','live','final','postponed','canceled'].includes(raw.status)) return fail();
      const away=cleanTeam(raw.away),home=cleanTeam(raw.home);
      if(away.id===home.id || (raw.selectedTeamId!==null && ![away.id,home.id].includes(raw.selectedTeamId))) return fail();
      const startTime=new Date(raw.startTime).toISOString();
      if(raw.date!==dateKey(startTime)) return fail();
      let score=null;
      if(raw.score!=null) { if(!Number.isInteger(raw.score.away) || !Number.isInteger(raw.score.home) || raw.score.away<0 || raw.score.home<0 || raw.score.away>100 || raw.score.home>100) return fail(); score={away:raw.score.away,home:raw.score.home}; }
      if(raw.status==='final' && (!score || score.away===score.home)) return fail();
      const winnerTeamId=raw.status==='final' ? (score.away>score.home?away.id:home.id) : null;
      const pregameStreaks={away:cleanStreak(raw.pregameStreaks?.away),home:cleanStreak(raw.pregameStreaks?.home)};
      const p={gameId:raw.gameId,date:dateKey(startTime),startTime,season:raw.season,seasonType:raw.seasonType,away,home,selectedTeamId:raw.selectedTeamId,createdAt:new Date(raw.createdAt).toISOString(),updatedAt:new Date(raw.updatedAt).toISOString(),lockedAt:validTime(raw.lockedAt)?new Date(raw.lockedAt).toISOString():null,status:raw.status,timeValid:raw.timeValid!==false,detail:typeof raw.detail==='string'?raw.detail.slice(0,80):'',score,winnerTeamId,pregameStreaks,streaksVerified:raw.streaksVerified===true && pregameStreaks.away!==null && pregameStreaks.home!==null,result:'pending',streakBreaks:[]};
      if(p.status==='final' || p.status==='live') p.lockedAt=p.lockedAt || p.startTime;
      settle(p); entries.set(p.gameId,chooseRecord(entries.get(p.gameId),p));
    }
    return {schemaVersion:1,username:input.username,usernameUpdatedAt:validTime(input.usernameUpdatedAt)?new Date(input.usernameUpdatedAt).toISOString():'1970-01-01T00:00:00.000Z',theme:input.theme || 'light',themeUpdatedAt:validTime(input.themeUpdatedAt)?new Date(input.themeUpdatedAt).toISOString():'1970-01-01T00:00:00.000Z',predictions:[...entries.values()]};
  }
  function exportData() {
    const blob=new Blob([JSON.stringify({...profile,exportedAt:isoNow()},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob), link=document.createElement('a');
    link.href=url; link.download=`nhl-profile-${today()}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  async function importData(file) {
    if(!file) return;
    try {
      const imported=validateProfile(JSON.parse(await file.text())), count=profile.predictions.length;
      profile=mergeProfiles(profile,imported);
      // Importing an exported profile explicitly restores its optional username.
      profile.username=imported.username; profile.usernameUpdatedAt=isoNow();
      profile.theme=imported.theme; profile.themeUpdatedAt=isoNow();
      const saved=await saveProfile();
      $('import-status').textContent=`Imported ${profile.predictions.length-count} new prediction${profile.predictions.length-count===1?'':'s'}; ${profile.predictions.length} preserved in total.${saved?' Saved on this device.':' Export a backup before closing.'}`;
      renderAll(); catchUp();
    } catch(error) { $('import-status').textContent=error instanceof SyntaxError ? 'This file is not valid JSON. No data was imported.' : error.message; }
    finally { $('import-data').value=''; }
  }
  function route() {
    closeTeamPopover();
    const [page,query='']=location.hash.slice(1).split('?'),params=new URLSearchParams(query);
    activePage=['schedule','history','stats','profile'].includes(page)?page:'schedule';
    historySelection=null;
    if(activePage==='history') {
      renderHistorySeasons();
      const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && addDays(value,0)===value;
      for(const name of ['from','to']) $('history-'+name).value=validDate(params.get(name))?params.get(name):'';
      $('history-season').value=params.get('season') || '';
      if(params.has('record')) {
        const record=personalRecords(profile.predictions).find(r=>r.id===params.get('record'));
        if(record?.games.length) {
          historySelection=record;
          $('history-season').value='';
          $('history-from').value=record.games[0].date;
          $('history-to').value=record.games[record.games.length-1].date;
        }
      }
    }
    for(const name of ['schedule','history','stats','profile']) { $(`${name}-page`).hidden=name!==activePage; const link=document.querySelector(`[data-page="${name}"]`); if(name===activePage) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); }
    document.title=`${({profile:'Local profile',history:'History',stats:'Stats',schedule:'Schedule'})[activePage]} · NHL`;
    renderAll();
    if(historySelection) requestAnimationFrame(()=>{
      const row=$('history-body').querySelector('tr[id]');
      row?.focus({preventScroll:true});
      row?.scrollIntoView({block:'center'});
    });
    else window.scrollTo({top:0});
  }
  async function init() {
    await openStorage();
    setupTeamPopovers();
    $('theme-toggle').addEventListener('click',async()=> {
      profile.theme=profile.theme==='dark'?'light':'dark';
      profile.themeUpdatedAt=new Date(Math.max(Date.now(),Date.parse(profile.themeUpdatedAt)+1)).toISOString();
      renderAll(); $('theme-status').textContent=await saveProfile()?'Appearance saved.':'Could not save. Export a backup before closing.';
    });
    $('schedule-body').addEventListener('click',event=> { const button=event.target.closest('button[data-game]'); if(button) pick(button.dataset.game,button.dataset.team); });
    $('previous-week').addEventListener('click',()=>{week=addDays(week,-7);loadWeek();});
    $('next-week').addEventListener('click',()=>{week=addDays(week,7);loadWeek();});
    $('this-week').addEventListener('click',()=>{week=monday(today());loadWeek();});
    $('refresh').addEventListener('click',refresh);
    $('upcoming-tab').addEventListener('click',()=>{gameFilter='upcoming';renderSchedule();});
    $('final-tab').addEventListener('click',()=>{gameFilter='final';renderSchedule();});
    const clearRecordSelection=()=>{historySelection=null;history.replaceState(null,'','#history');};
    for(const id of ['history-season','history-from','history-to']) $(id).addEventListener('change',()=>{clearRecordSelection();renderHistory();});
    $('clear-filters').addEventListener('click',()=>{clearRecordSelection();for(const id of ['history-season','history-from','history-to']) $(id).value='';renderHistory();});
    $('username-form').addEventListener('submit',async event=> { event.preventDefault(); profile.username=$('username').value.trim().slice(0,40); profile.usernameUpdatedAt=isoNow(); renderHeader(); $('username-status').textContent=await saveProfile()?'Saved.':'Could not save. Export a backup.'; });
    $('export-data').addEventListener('click',exportData);
    $('import-data').addEventListener('change',event=>importData(event.target.files[0]));
    window.addEventListener('hashchange',route);
    window.addEventListener('online',refresh);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden) refresh();});
    route(); refresh();
    setInterval(()=> { if(!document.hidden) refresh(); },60000);
    let lastLockState='',lastDay=today();
    setInterval(()=> {
      if(document.hidden) return;
      const lockState=[...games.values()].map(g=>`${g.gameId}:${canPick(g)}`).join('|');
      if(lockState!==lastLockState) { lastLockState=lockState; renderSchedule(); }
      if(today()!==lastDay) { lastDay=today(); renderHeader(); renderProfile(); renderStats(); }
    },1000);
  }
  init().catch(()=>notice('The page could not initialize. Reload to retry. Existing saved history has not been removed.'));
})();
