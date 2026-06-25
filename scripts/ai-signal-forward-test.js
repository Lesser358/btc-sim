#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'ai-signal-forward.json');
const BINANCE = 'https://fapi.binance.com';
const TAKER = 0.0005;
const MAX_PENDING = 800;
const MAX_RECENT = 120;
const MAX_RUNS = 40;
const SYMS = ['btcusdt','ethusdt','solusdt','bnbusdt','xrpusdt','dogeusdt','adausdt','avaxusdt'];
const IV_SEC = {'1m':60,'3m':180,'5m':300,'15m':900,'30m':1800,'1h':3600,'2h':7200,'4h':14400,'1d':86400};

const SIGNAL_STYLE_CFG = {
  scalping: {
    label:'scalping', iv1:'3m',lim1:120, iv2:'1m',lim2:120,
    emaFast:7,emaSlow:25, mom1BarsBack:3,mom2BarsBack:6,
    rsiPrd:9,atrPrd:14, volRecentN:3,volBaseN:20,
    rsiHigh:76,rsiLow:24,
    wTrend:8,wMom1:12,wMom2:8,wChg24:0.6,wRsi:5,wFund:40,wVol:10,atrWarnPct:1.8,
    wConfluence:8,wMomH2:5, useVwap:true,vwapN:40,wVwap:7,
    wDiv:6,wAbsorb:6,divLook:24,
    wOb:8,wObWall:4,obPct:0.004,
    minBars1:40,minBars2:40
  },
  scalp: {
    label:'scalp', iv1:'15m',lim1:100, iv2:'5m',lim2:100,
    emaFast:9,emaSlow:21, mom1BarsBack:4,mom2BarsBack:8,
    rsiPrd:14,atrPrd:14, volRecentN:3,volBaseN:15,
    rsiHigh:72,rsiLow:28,
    wTrend:10,wMom1:10,wMom2:8,wChg24:1.0,wRsi:6,wFund:80,wVol:6,atrWarnPct:3.5,
    wConfluence:8,wMomH2:6, wDiv:7,wAbsorb:5,divLook:24,
    wOb:6,wObWall:3,obPct:0.006,
    minBars1:40,minBars2:20
  },
  swing: {
    label:'swing', iv1:'1h',lim1:150, iv2:'15m',lim2:96,
    emaFast:20,emaSlow:50, mom1BarsBack:5,mom2BarsBack:9,
    rsiPrd:14,atrPrd:14, volRecentN:12,volBaseN:48,
    rsiHigh:74,rsiLow:26,
    wTrend:15,wMom1:8,wMom2:6,wChg24:1.2,wRsi:8,wFund:140,wVol:8,atrWarnPct:4.8,
    wConfluence:10,wMomH2:4, wDiv:8,wAbsorb:4,divLook:30,
    wOb:3,wObWall:0,obPct:0.01,
    minBars1:60,minBars2:20
  },
  mid: {
    label:'mid', iv1:'4h',lim1:120, iv2:'1d',lim2:60,
    emaFast:20,emaSlow:50, mom1BarsBack:6,mom2BarsBack:14,
    rsiPrd:14,atrPrd:14, volRecentN:6,volBaseN:30,
    rsiHigh:74,rsiLow:26,
    wTrend:22,wMom1:5,wMom2:4,wChg24:0.8,wRsi:6,wFund:100,wVol:5,atrWarnPct:7.0,
    wConfluence:12,wMomH2:3, wDiv:8,wAbsorb:3,divLook:24,
    minBars1:60,minBars2:10
  }
};

const SIG_EVAL = {
  scalping:{ horizonMs:30*60*1000,        winPct:0.15 },
  scalp:   { horizonMs:4*60*60*1000,      winPct:0.4  },
  swing:   { horizonMs:24*60*60*1000,     winPct:1.0  },
  mid:     { horizonMs:4*24*60*60*1000,   winPct:2.0  }
};

function initState(){
  return {
    version: 1,
    source: 'github-actions',
    updatedAt: null,
    pending: [],
    styles: {},
    latestSignals: {},
    recentEvaluations: [],
    runs: []
  };
}

function loadState(){
  try{
    if(!fs.existsSync(OUT_PATH)) return initState();
    const data = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return normalizeState(data);
  }catch(e){
    return initState();
  }
}

function normalizeState(data){
  const s = data && typeof data === 'object' ? data : initState();
  s.version = 1;
  s.source = 'github-actions';
  s.pending = Array.isArray(s.pending) ? s.pending : [];
  s.styles = s.styles && typeof s.styles === 'object' ? s.styles : {};
  s.latestSignals = s.latestSignals && typeof s.latestSignals === 'object' ? s.latestSignals : {};
  s.recentEvaluations = Array.isArray(s.recentEvaluations) ? s.recentEvaluations : [];
  s.runs = Array.isArray(s.runs) ? s.runs : [];
  return s;
}

function saveState(state){
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(state, null, 2) + '\n');
}

function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
function avg(arr){ return arr && arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function lastVal(data){ return data && data.length ? data[data.length-1].value : null; }
function symShort(sym){ return String(sym || '').replace(/usdt$/i, '').toUpperCase(); }

function emaArr(arr, period){
  const k=2/(period+1); let e=null; const out=[];
  for(let i=0;i<arr.length;i++){
    if(i<period-1){ out.push(null); continue; }
    if(i===period-1){ let s=0; for(let j=0;j<period;j++) s+=arr[j]; e=s/period; }
    else e=arr[i]*k+e*(1-k);
    out.push(e);
  }
  return out;
}

function calcEMA(src, period){
  const v=emaArr(src.map(c=>c.close),period), out=[];
  v.forEach((x,i)=>{ if(x!=null) out.push({time:src[i].time,value:x}); });
  return out;
}

function calcRSI(src, period){
  const cl=src.map(c=>c.close), out=[]; let ag=0,al=0;
  if(cl.length <= period) return out;
  for(let i=1;i<=period;i++){ const d=cl[i]-cl[i-1]; if(d>0) ag+=d; else al-=d; }
  ag/=period; al/=period;
  for(let i=period;i<cl.length;i++){
    if(i>period){ const d=cl[i]-cl[i-1]; ag=(ag*(period-1)+(d>0?d:0))/period; al=(al*(period-1)+(d<0?-d:0))/period; }
    out.push({time:src[i].time, value:al===0?100:100-(100/(1+ag/al))});
  }
  return out;
}

function calcATR(src, period){
  const out=[]; let prev=null;
  for(let i=1;i<src.length;i++){
    const tr=Math.max(src[i].high-src[i].low,Math.abs(src[i].high-src[i-1].close),Math.abs(src[i].low-src[i-1].close));
    if(i<period){ if(prev===null) prev=0; prev+=tr/period; continue; }
    if(i===period) prev+=tr/period; else prev=(prev*(period-1)+tr)/period;
    out.push({time:src[i].time,value:prev});
  }
  return out;
}

function klineRows(raw){
  return (Array.isArray(raw)?raw:[]).map(k=>({
    time:Math.floor(+k[0]/1000),
    open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
  })).filter(c=>c.close>0&&c.high>0&&c.low>0);
}

function vwap(arr,n){
  if(!arr||!arr.length) return null;
  const s=arr.slice(-Math.min(n||40,arr.length));
  let pv=0,v=0;
  for(const c of s){ const tp=(c.high+c.low+c.close)/3; pv+=tp*c.volume; v+=c.volume; }
  return v>0?pv/v:null;
}

function tfConfirm(h2,cfg){
  const out={dir:0,mom:0};
  if(!h2||h2.length<cfg.emaSlow+2) return out;
  const f2=lastVal(calcEMA(h2,cfg.emaFast));
  const s2=lastVal(calcEMA(h2,cfg.emaSlow));
  if(f2>0&&s2>0) out.dir=Math.sign(f2-s2);
  const back=Math.min(h2.length-1,cfg.mom1BarsBack);
  const p2=h2[h2.length-1-back].close;
  if(p2>0) out.mom=(h2[h2.length-1].close/p2-1)*100;
  return out;
}

function divergence(h1, rsiSeries, look){
  if(!h1||!rsiSeries||rsiSeries.length<look||h1.length<look) return 0;
  const c=h1.slice(-look), rs=rsiSeries.slice(-look).map(r=>r.value);
  const mid=Math.floor(look/2);
  if(mid<2) return 0;
  const oldC=c.slice(0,mid), recC=c.slice(mid), oldR=rs.slice(0,mid), recR=rs.slice(mid);
  const hi=a=>Math.max(...a.map(x=>x.high)), lo=a=>Math.min(...a.map(x=>x.low));
  const mx=a=>Math.max(...a), mn=a=>Math.min(...a);
  if(hi(recC)>hi(oldC) && mx(recR)<mx(oldR) && mx(recR)>55) return -1;
  if(lo(recC)<lo(oldC) && mn(recR)>mn(oldR) && mn(recR)<45) return 1;
  return 0;
}

function absorption(h1, volRel){
  if(!h1||h1.length<2||volRel<1.6) return 0;
  const c=h1[h1.length-1], range=c.high-c.low;
  if(!(range>0)) return 0;
  const body=Math.abs(c.close-c.open);
  const upWick=c.high-Math.max(c.open,c.close), loWick=Math.min(c.open,c.close)-c.low;
  if(body/range>=0.4) return 0;
  if(loWick>upWick*1.5) return 1;
  if(upWick>loWick*1.5) return -1;
  return 0;
}

function obImbalance(depth, pct){
  if(!depth||!Array.isArray(depth.bids)||!Array.isArray(depth.asks)||!depth.bids.length||!depth.asks.length) return null;
  const bestBid=+depth.bids[0][0], bestAsk=+depth.asks[0][0];
  if(!(bestBid>0)||!(bestAsk>0)) return null;
  const mid=(bestBid+bestAsk)/2, loB=mid*(1-pct), hiA=mid*(1+pct);
  let bidVal=0,askVal=0,maxBid=0,maxAsk=0;
  for(const lv of depth.bids){ const pr=+lv[0]; if(pr<loB) break; const v=pr*(+lv[1]); bidVal+=v; if(v>maxBid) maxBid=v; }
  for(const lv of depth.asks){ const pr=+lv[0]; if(pr>hiA) break; const v=pr*(+lv[1]); askVal+=v; if(v>maxAsk) maxAsk=v; }
  const tot=bidVal+askVal;
  if(!(tot>0)) return null;
  const imb=(bidVal-askVal)/tot;
  let wall=0;
  if(maxAsk>askVal*0.5 && maxAsk>maxBid*1.5) wall=-1;
  else if(maxBid>bidVal*0.5 && maxBid>maxAsk*1.5) wall=1;
  return { imb, wall };
}

function calcSignal(sym,h1,h2,ticker,premium,cfg,depth){
  const fail={sym,type:'wait',label:'wait',score:0,confidence:0,reason:'not enough market data',metrics:{},volume24h:0};
  if(!h1||h1.length<cfg.minBars1||!h2||h2.length<cfg.minBars2) return fail;
  const close=h1[h1.length-1].close;
  const prevMom1=h1[Math.max(0,h1.length-1-cfg.mom1BarsBack)].close;
  const prevMom2=h1[Math.max(0,h1.length-1-cfg.mom2BarsBack)].close;
  const emaFast=lastVal(calcEMA(h1,cfg.emaFast));
  const emaSlow=lastVal(calcEMA(h1,cfg.emaSlow));
  const rsiSeries=calcRSI(h1,cfg.rsiPrd);
  const rsi=lastVal(rsiSeries)??50;
  const atr=lastVal(calcATR(h1,cfg.atrPrd))||close*0.02;
  if(!(close>0)||!(emaFast>0)||!(emaSlow>0)) return fail;
  const trendPct=(emaFast/emaSlow-1)*100;
  const mom1=prevMom1>0?(close/prevMom1-1)*100:0;
  const mom2=prevMom2>0?(close/prevMom2-1)*100:0;
  const change24=ticker?.priceChangePercent!=null?+ticker.priceChangePercent:0;
  const fundingPct=premium?.lastFundingRate!=null?+premium.lastFundingRate*100:0;
  const recentVol=avg(h1.slice(-cfg.volRecentN).map(c=>c.volume));
  const baseVol=avg(h1.slice(-cfg.volBaseN,-cfg.volRecentN).map(c=>c.volume))||recentVol||1;
  const volRel=recentVol/baseVol;
  const atrPct=atr/close*100;
  let raw=0;
  raw+=clamp(trendPct*cfg.wTrend,-28,28);
  raw+=clamp(mom1*cfg.wMom1,-24,24);
  raw+=clamp(mom2*cfg.wMom2,-18,18);
  raw+=clamp(change24*cfg.wChg24,-14,14);
  if(rsi>=cfg.rsiHigh) raw-=cfg.wRsi;
  else if(rsi<=cfg.rsiLow) raw+=cfg.wRsi;
  else if(rsi>=62&&trendPct>0) raw+=Math.round(cfg.wRsi*0.6);
  else if(rsi<=38&&trendPct<0) raw-=Math.round(cfg.wRsi*0.6);
  raw-=clamp(fundingPct*cfg.wFund,-10,10);
  const tf2=tfConfirm(h2,cfg);
  const h1Dir=Math.sign(trendPct);
  let agree=0;
  if(h1Dir!==0&&tf2.dir!==0) agree=(h1Dir===tf2.dir)?1:-1;
  if(agree>0) raw+=h1Dir*(cfg.wConfluence||0);
  raw+=clamp(tf2.mom*(cfg.wMomH2||0),-12,12);
  let vwapPct=null;
  if(cfg.useVwap){
    const vw=vwap(h1,cfg.vwapN);
    if(vw>0){ vwapPct=(close/vw-1)*100; raw+=clamp(vwapPct*(cfg.wVwap||6),-12,12); }
  }
  const div=divergence(h1,rsiSeries,cfg.divLook||24);
  const abs=absorption(h1,volRel);
  raw+=div*(cfg.wDiv||0);
  raw+=abs*(cfg.wAbsorb||0);
  let obImb=null, obWall=0;
  if(cfg.wOb>0 && depth){
    const ob=obImbalance(depth, cfg.obPct||0.005);
    if(ob){ obImb=ob.imb; obWall=ob.wall; raw+=clamp(ob.imb*cfg.wOb, -cfg.wOb, cfg.wOb); raw+=obWall*(cfg.wObWall||0); }
  }
  const signBase=raw||mom1||change24;
  if(volRel>1.25&&signBase) raw+=Math.sign(signBase)*Math.min(cfg.wVol,(volRel-1)*cfg.wVol);
  if(atrPct>cfg.atrWarnPct) raw*=0.85;
  if(agree<0) raw*=0.7;
  const type=raw>=10?'long':raw<=-10?'short':'wait';
  let confidence=type==='wait'
    ? Math.max(30,Math.round(55-Math.min(20,Math.abs(raw))))
    : Math.min(95,Math.round(52+Math.abs(raw)*1.15));
  if(type!=='wait'){
    if(agree<0) confidence=Math.max(35,confidence-12);
    else if(agree>0) confidence=Math.min(96,confidence+5);
  }
  const reasons=[];
  if(Math.abs(trendPct)>0.15) reasons.push(`EMA ${trendPct>0?'up':'down'}`);
  if(agree>0) reasons.push('tf agree');
  else if(agree<0) reasons.push('tf conflict');
  if(Math.abs(mom1)>0.35) reasons.push(`momentum ${mom1>0?'strong':'weak'}`);
  if(vwapPct!=null&&Math.abs(vwapPct)>0.05) reasons.push(`VWAP ${vwapPct>0?'above':'below'}`);
  if(volRel>1.25) reasons.push(`volume x${volRel.toFixed(1)}`);
  if(fundingPct>0.04) reasons.push('long crowded funding');
  else if(fundingPct<-0.02) reasons.push('short crowded funding');
  if(rsi>=cfg.rsiHigh) reasons.push('RSI hot');
  else if(rsi<=cfg.rsiLow) reasons.push('RSI low');
  if(div>0) reasons.push('bullish divergence');
  else if(div<0) reasons.push('bearish divergence');
  if(abs>0) reasons.push('sell absorption');
  else if(abs<0) reasons.push('buy absorption');
  if(obWall>0) reasons.push('bid wall');
  else if(obWall<0) reasons.push('ask wall');
  if(obImb!=null&&Math.abs(obImb)>0.25) reasons.push(`book ${obImb>0?'bid':'ask'} bias`);
  if(!reasons.length) reasons.push(type==='wait'?'mixed':'signal');
  return {
    sym,type,label:type==='long'?'long bias':type==='short'?'short bias':'wait',
    score:Math.round(raw),confidence,volume24h:ticker?.quoteVolume?+ticker.quoteVolume:0,
    reason:reasons.slice(0,3).join(' / '),
    metrics:{ change24:+change24.toFixed(3), rsi:+rsi.toFixed(1), fundingPct:+fundingPct.toFixed(4), atrPct:+atrPct.toFixed(3) },
    entry: ticker?.lastPrice ? +ticker.lastPrice : close
  };
}

function tradeCfg(style){
  const ev=SIG_EVAL[style]||SIG_EVAL.swing;
  const slipOneWay={scalping:0.02,scalp:0.03,swing:0.04,mid:0.05}[style] ?? 0.04;
  return {
    tpPct: ev.winPct*2.0,
    slPct: ev.winPct*1.2,
    costPct: (TAKER*2*100) + slipOneWay*2
  };
}

function simTrade(type, entry, futureBars, style){
  if(!(entry>0)||!futureBars||!futureBars.length) return null;
  const tc=tradeCfg(style);
  let mfe=0, mae=0, exitKind='time', grossPct=0;
  for(const b of futureBars){
    const fav = type==='long' ? (b.high/entry-1)*100 : ((entry-b.low)/entry)*100;
    const adv = type==='long' ? (b.low/entry-1)*100 : ((entry-b.high)/entry)*100;
    if(fav>mfe) mfe=fav;
    if(adv<mae) mae=adv;
    const hitTp=fav>=tc.tpPct, hitSl=adv<=-tc.slPct;
    if(hitTp||hitSl){
      if(hitSl){ exitKind='sl'; grossPct=-tc.slPct; }
      else { exitKind='tp'; grossPct=tc.tpPct; }
      break;
    }
  }
  if(exitKind==='time'){
    const last=futureBars[futureBars.length-1];
    grossPct=(type==='long' ? (last.close/entry-1) : ((entry-last.close)/entry))*100;
  }
  return { exitKind, grossPct, netPct:grossPct-tc.costPct, mfePct:mfe, maePct:mae, costPct:tc.costPct };
}

function styleBucket(state, style){
  if(!state.styles[style]){
    state.styles[style]={win:0,loss:0,flat:0,total:0,tradeWin:0,tradeLoss:0,tradeFlat:0,netSum:0,gainSum:0,lossSum:0,mfeSum:0,maeSum:0,tpHit:0,slHit:0,timeExit:0,dropped:0,lastEvalAt:null};
  }
  return state.styles[style];
}

function recordEvaluation(state, p, exitPx, trade, nowIso){
  const ev=SIG_EVAL[p.style];
  const b=styleBucket(state, p.style);
  const movePct=(exitPx/p.entry-1)*100;
  const fav=p.type==='long'?movePct:((p.entry-exitPx)/p.entry)*100;
  if(fav>=ev.winPct) b.win++;
  else if(fav<=-ev.winPct) b.loss++;
  else b.flat++;
  if(trade.netPct>0) b.tradeWin++;
  else if(trade.netPct<0) b.tradeLoss++;
  else b.tradeFlat++;
  b.netSum+=trade.netPct;
  if(trade.netPct>0) b.gainSum+=trade.netPct;
  else if(trade.netPct<0) b.lossSum+=Math.abs(trade.netPct);
  b.mfeSum+=trade.mfePct;
  b.maeSum+=trade.maePct;
  if(trade.exitKind==='tp') b.tpHit++;
  else if(trade.exitKind==='sl') b.slHit++;
  else b.timeExit++;
  b.total++;
  b.lastEvalAt=nowIso;
  state.recentEvaluations.unshift({
    style:p.style, sym:p.sym, type:p.type,
    entry:+p.entry.toFixed(8), exit:+exitPx.toFixed(8),
    grossPct:+trade.grossPct.toFixed(4), netPct:+trade.netPct.toFixed(4),
    exitKind:trade.exitKind, ts:p.ts, evalAt:p.evalAt, evaluatedAt:nowIso
  });
  state.recentEvaluations=state.recentEvaluations.slice(0, MAX_RECENT);
}

async function fetchJson(endpoint){
  const url = endpoint.startsWith('http') ? endpoint : BINANCE + endpoint;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 20000);
  try{
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'btc-futures-sim-forward-test' } });
    if(!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  }finally{
    clearTimeout(timer);
  }
}

async function fetchKlines(symbol, interval, limit, startTime, endTime){
  const params = new URLSearchParams({ symbol: symbol.toUpperCase(), interval, limit: String(limit || 500) });
  if(startTime) params.set('startTime', String(startTime));
  if(endTime) params.set('endTime', String(endTime));
  return klineRows(await fetchJson(`/fapi/v1/klines?${params.toString()}`));
}

async function evaluatePending(state, now){
  const keep=[];
  for(const p of state.pending){
    const ev=SIG_EVAL[p.style], cfg=SIGNAL_STYLE_CFG[p.style];
    if(!ev||!cfg||!(p.entry>0)){ continue; }
    if(now < p.evalAt){ keep.push(p); continue; }
    try{
      const ivMs=(IV_SEC[cfg.iv1]||3600)*1000;
      const bars=await fetchKlines(p.sym, cfg.iv1, 1000, Math.max(0, p.ts - ivMs), p.evalAt + ivMs);
      const future=bars.filter(b=>b.time*1000 > p.ts && b.time*1000 <= p.evalAt + ivMs);
      if(!future.length){
        if(now < p.evalAt + Math.max(ev.horizonMs, 6*60*60*1000)) keep.push(p);
        else styleBucket(state, p.style).dropped++;
        continue;
      }
      const trade=simTrade(p.type, p.entry, future, p.style);
      if(!trade){ keep.push(p); continue; }
      const exitPx=future[future.length-1].close;
      recordEvaluation(state, p, exitPx, trade, new Date(now).toISOString());
    }catch(e){
      if(now < p.evalAt + Math.max(ev.horizonMs, 6*60*60*1000)) keep.push(p);
      else styleBucket(state, p.style).dropped++;
    }
  }
  state.pending=keep.slice(-MAX_PENDING);
}

async function loadSignalRows(style, tickerMap, premiumMap){
  const cfg=SIGNAL_STYLE_CFG[style];
  const rows=[];
  for(const sym of SYMS){
    try{
      const up=sym.toUpperCase();
      const [h1,h2,depth]=await Promise.all([
        fetchKlines(up, cfg.iv1, cfg.lim1),
        fetchKlines(up, cfg.iv2, cfg.lim2),
        cfg.wOb>0 ? fetchJson(`/fapi/v1/depth?symbol=${up}&limit=100`).catch(()=>null) : Promise.resolve(null)
      ]);
      rows.push(calcSignal(sym,h1,h2,tickerMap[sym],premiumMap[sym],cfg,depth));
    }catch(e){
      rows.push({sym,type:'wait',score:0,confidence:0,volume24h:0,reason:'fetch failed',metrics:{}});
    }
  }
  return rows.sort((a,b)=>(b.volume24h||0)-(a.volume24h||0));
}

function compactSignal(row){
  return {
    sym:row.sym, coin:symShort(row.sym), type:row.type,
    score:row.score||0, confidence:row.confidence||0,
    entry:row.entry ? +row.entry.toFixed(8) : null,
    reason:row.reason||'', metrics:row.metrics||{}
  };
}

function recordNewSignals(state, style, rows, now){
  const ev=SIG_EVAL[style];
  const open=new Set(state.pending.filter(p=>p.style===style).map(p=>p.sym));
  let added=0;
  for(const r of rows){
    if(!r||r.type==='wait'||open.has(r.sym)||!(r.entry>0)) continue;
    state.pending.push({
      id:`${style}:${r.sym}:${now}`,
      style, sym:r.sym, type:r.type,
      entry:r.entry, score:r.score||0, confidence:r.confidence||0,
      ts:now, evalAt:now+ev.horizonMs
    });
    open.add(r.sym);
    added++;
  }
  if(state.pending.length>MAX_PENDING) state.pending=state.pending.slice(-MAX_PENDING);
  return added;
}

async function runForward(){
  const state=loadState();
  const now=Date.now();
  const nowIso=new Date(now).toISOString();
  await evaluatePending(state, now);

  // 앱(loadAiCoinSignals)과 동일하게 시장 전체 조회 실패를 흡수 — 한쪽 실패로 run 전체가 크래시(exit 1)하지 않도록.
  // (GitHub Actions 러너가 지역 차단(HTTP 451)되면 빈 맵으로 graceful no-op 처리)
  const [tickers, premiums] = await Promise.all([
    fetchJson('/fapi/v1/ticker/24hr').catch(e=>{ console.warn('ticker fetch failed:', e.message); return []; }),
    fetchJson('/fapi/v1/premiumIndex').catch(e=>{ console.warn('premium fetch failed:', e.message); return []; })
  ]);
  const tickerMap={}, premiumMap={};
  if(Array.isArray(tickers)) tickers.forEach(d=>{ if(d&&d.symbol) tickerMap[d.symbol.toLowerCase()]=d; });
  if(Array.isArray(premiums)) premiums.forEach(d=>{ if(d&&d.symbol) premiumMap[d.symbol.toLowerCase()]=d; });

  let added=0;
  for(const style of Object.keys(SIGNAL_STYLE_CFG)){
    const rows=await loadSignalRows(style, tickerMap, premiumMap);
    state.latestSignals[style]=rows.map(compactSignal);
    added+=recordNewSignals(state, style, rows, now);
  }

  state.updatedAt=nowIso;
  state.pending=state.pending.slice(-MAX_PENDING);
  state.runs.unshift({ ts:nowIso, added, pending:state.pending.length });
  state.runs=state.runs.slice(0, MAX_RUNS);
  saveState(state);
  console.log(`forward test updated: added=${added}, pending=${state.pending.length}`);
}

function selfTest(){
  const longTp=simTrade('long', 100, [{high:103,low:99.5,close:102}], 'swing');
  if(longTp.exitKind!=='tp' || Math.abs(longTp.grossPct-2)>1e-9) throw new Error('long TP failed');
  const both=simTrade('long', 100, [{high:103,low:98,close:102}], 'swing');
  if(both.exitKind!=='sl') throw new Error('same-bar TP/SL should prefer SL');
  const shortTime=simTrade('short', 100, [{high:101,low:97.5,close:97}], 'mid');
  if(shortTime.exitKind!=='time' || Math.abs(shortTime.grossPct-3)>1e-9) throw new Error('short time exit failed');
  const shortSl=simTrade('short', 100, [{high:103,low:99,close:102}], 'swing');
  if(shortSl.exitKind!=='sl') throw new Error('short SL failed');
  console.log('self-test ok');
}

if(require.main === module){
  if(process.argv.includes('--self-test')) selfTest();
  else runForward().catch(err=>{
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

