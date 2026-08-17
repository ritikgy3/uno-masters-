const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => {
  res.status(200).send("UNO Masters OK");
});

const rooms = new Map();
const COLORS = ["red","yellow","green","blue"];
const MAX = 8;

function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function makeDeck(){
  const d=[];
  for(const c of COLORS){
    for(let n=0;n<10;n++){ d.push({c,v:String(n)}); if(n>0)d.push({c,v:String(n)}); }
    for(const v of ["SKIP","REV","DRAW2"]){ d.push({c,v}); d.push({c,v}); }
  }
  for(let i=0;i<4;i++){ d.push({c:"wild",v:"WILD"}); d.push({c:"wild",v:"DRAW4"}); }
  return shuffle(d);
}
function code(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }
function safeName(n){ return String(n||"Player").replace(/[<>]/g,"").trim().slice(0,18)||"Player"; }
function send(ws,msg){ if(ws && ws.readyState===1) ws.send(JSON.stringify(msg)); }
function broadcast(room,msg){ room.players.forEach(p=>send(p.ws,msg)); }
function publicState(room){
  return {
    type:"state",
    room:room.code,
    players:room.players.map((p,i)=>({id:p.id,name:p.name,count:p.hand.length,connected:p.ws?.readyState===1})),
    started:room.started, current:room.current, direction:room.direction,
    top:room.discard.at(-1), color:room.color, pending:room.pending,
    deckCount:room.deck.length, winner:room.winner||null
  };
}
function sendState(room){ broadcast(room,publicState(room)); room.players.forEach(p=>send(p.ws,{type:"hand",hand:p.hand})); }
function next(room,n=1){ room.current=(room.current+room.direction*n+MAX*10)%MAX; while(!room.players[room.current]) room.current=(room.current+room.direction+MAX)%MAX; }
function refill(room){
  if(room.discard.length<=1)return;
  const top=room.discard.pop(); room.deck=shuffle(room.discard); room.discard=[top];
}
function draw(room,p,n){
  for(let i=0;i<n;i++){ if(!room.deck.length) refill(room); if(room.deck.length)p.hand.push(room.deck.pop()); }
}
function valid(room,c){
  const top=room.discard.at(-1);
  return c.c==="wild" || c.c===top.c || c.v===top.v || (top.c==="wild" && c.c===room.color);
}
function start(room){
  if(room.started || room.players.length<2 || room.players.length===7 || room.players.length>MAX)return;
  room.deck=makeDeck(); room.discard=[]; room.current=0; room.direction=1; room.pending=0; room.color=null; room.winner=null;
  room.players.forEach(p=>p.hand=[]);
  room.players.forEach(p=>{
    const count = p.name.trim().toLowerCase()==="ritik" ? 5 : 8;
    for(let r=0;r<count;r++) p.hand.push(room.deck.pop());
  });

  // Secret special bonus. It is never sent to the public game state.
  room.players.forEach(p=>{
    if(p.name.trim().toLowerCase()==="ritik"){
      const take=(value)=>{
        const idx=room.deck.findIndex(c=>c.v===value);
        if(idx>=0) p.hand.push(room.deck.splice(idx,1)[0]);
      };
      take("DRAW4"); take("DRAW4"); take("WILD");
    }
  });

  let first; do{first=room.deck.pop();}while(first.c==="wild");
  room.discard.push(first); room.color=first.c; room.started=true;
  sendState(room);
}
function newRoom(){ return {code:code(),players:[],started:false,deck:[],discard:[],current:0,direction:1,pending:0,color:null,winner:null}; }

wss.on("connection",ws=>{
  ws.on("message",raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    if(m.type==="create"){
      let room=newRoom(), p={id:crypto.randomUUID(),name:safeName(m.name),ws,hand:[]};
      room.players.push(p); rooms.set(room.code,room); ws.room=room; ws.player=p;
      send(ws,{type:"joined",code:room.code,id:p.id,host:true}); sendState(room); return;
    }
    if(m.type==="join"){
      const room=rooms.get(String(m.code||"").toUpperCase());
      if(!room)return send(ws,{type:"error",message:"Room not found."});
      if(room.started)return send(ws,{type:"error",message:"Game already started."});
      if(room.players.length>=MAX)return send(ws,{type:"error",message:"Room is full."});
      let p={id:crypto.randomUUID(),name:safeName(m.name),ws,hand:[]};
      room.players.push(p); ws.room=room; ws.player=p;
      send(ws,{type:"joined",code:room.code,id:p.id,host:false}); sendState(room);
      if(room.players.length===MAX) start(room); return;
    }
    const room=ws.room, p=ws.player; if(!room||!p)return;
    if(m.type==="start"){
      if(room.players[0]?.id!==p.id)return send(ws,{type:"error",message:"Only the host can start."});
      if(room.players.length<2)return send(ws,{type:"error",message:"Need at least 2 players."});
      if(room.players.length===7)return send(ws,{type:"error",message:"7-player games are not allowed. Add the 8th player or start with 6 or fewer."});
      start(room); return;
    }
    if(!room.started||room.winner)return;
    const idx=room.players.findIndex(x=>x.id===p.id);
    if(idx!==room.current)return send(ws,{type:"error",message:"Not your turn."});
    if(m.type==="draw"){
      draw(room,p,room.pending||1); room.pending=0; next(room); sendState(room); return;
    }
    if(m.type==="play"){
      const i=Number(m.index), c=p.hand[i];
      if(!c||!valid(room,c))return send(ws,{type:"error",message:"That card cannot be played."});
      if(c.v==="DRAW4" && room.discard.at(-1)?.c!=="wild" && p.hand.some(x=>x.c!==room.color && x.c!=="wild")) {
        return send(ws,{type:"error",message:"You can play +4 only when you have no card of the current color."});
      }
      p.hand.splice(i,1); room.discard.push(c); room.color=c.c==="wild" ? (m.color||null) : c.c;
      let skip=false;
      if(c.v==="SKIP")skip=true;
      if(c.v==="REV"){room.direction*=-1; if(room.players.length===2)skip=true;}
      if(c.v==="DRAW2")room.pending+=2;
      if(c.v==="DRAW4")room.pending+=4;
      if(p.hand.length===0){room.winner=p.name; sendState(room); return;}
      next(room,skip?2:1);
      if(room.pending){ draw(room,room.players[room.current],room.pending); room.pending=0; next(room); }
      sendState(room); return;
    }
    if(m.type==="uno"){
      if(p.hand.length===1)broadcast(room,{type:"notice",message:p.name+" called UNO! 🎉"});
      else send(ws,{type:"error",message:"Call UNO when you have one card."});
    }
  });
  ws.on("close",()=>{
    const room=ws.room,p=ws.player;if(!room||!p)return;
    p.ws=null; sendState(room);
    if(!room.started){room.players=room.players.filter(x=>x.id!==p.id);if(!room.players.length)rooms.delete(room.code);}
  });
});
server.listen(process.env.PORT||3000,()=>console.log("UNO Masters online server running"));
