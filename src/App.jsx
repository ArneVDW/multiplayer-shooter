import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  onSnapshot, 
  updateDoc, 
  arrayUnion
} from 'firebase/firestore';
import { Shield, Play, Skull, RotateCcw, Crosshair } from 'lucide-react';

// --- CONFIGURATIE ---
const FIREBASE_CONFIG = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
  apiKey: "AIzaSyDw-WSx1oYTHzadXUB7csmKNhZlO0RTw6Y",
  authDomain: "multiplayer-shooter-c0b9f.firebaseapp.com",
  projectId: "multiplayer-shooter-c0b9f",
  storageBucket: "multiplayer-shooter-c0b9f.firebasestorage.app",
  messagingSenderId: "773037810608",
  appId: "1:773037810608:web:f8b22fc68fa1e0c34f2c75"
};

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'mijn-shooter-game-v2';

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// Game Instellingen
const ACCELERATION = 0.5;
const FRICTION = 0.93;
const MAX_SPEED = 6;
const BULLET_SPEED = 14;
const RELOAD_TIME = 350; 
const MAP_WIDTH = 1600;  
const MAP_HEIGHT = 1200; 
const VIEWPORT_W = 800;
const VIEWPORT_H = 600;
const BULLET_LIFESPAN = 1500; // ms

// Uitgebreide obstakels
const OBSTACLES = [
  { x: 750, y: 550, w: 100, h: 100 },
  { x: 300, y: 200, w: 400, h: 40 },
  { x: 900, y: 200, w: 400, h: 40 },
  { x: 400, y: 500, w: 60, h: 60 },
  { x: 1140, y: 500, w: 60, h: 60 },
  { x: 400, y: 700, w: 60, h: 60 },
  { x: 1140, y: 700, w: 60, h: 60 },
  { x: 300, y: 1000, w: 1000, h: 40 },
  { x: 100, y: 300, w: 40, h: 600 },
  { x: 1460, y: 300, w: 40, h: 600 },
  { x: 200, y: 150, w: 40, h: 40 },
  { x: 1360, y: 150, w: 40, h: 40 },
];

function isPointInRect(x, y, rect, margin = 0) {
  return x >= rect.x - margin && x <= rect.x + rect.w + margin && 
         y >= rect.y - margin && y <= rect.y + rect.h + margin;
}

// Functie om een veilige spawnplek te vinden
const findSafeSpawn = () => {
  let safe = false;
  let spawn = { x: 800, y: 600 };
  let attempts = 0;
  
  while (!safe && attempts < 50) {
    spawn = {
      x: Math.random() * (MAP_WIDTH - 200) + 100,
      y: Math.random() * (MAP_HEIGHT - 200) + 100
    };
    
    let inObstacle = false;
    for (let obs of OBSTACLES) {
      if (isPointInRect(spawn.x, spawn.y, obs, 40)) { // 40px marge voor speler grootte
        inObstacle = true;
        break;
      }
    }
    if (!inObstacle) safe = true;
    attempts++;
  }
  return spawn;
};

export default function App() {
  const [user, setUser] = useState(null);
  const [gameState, setGameState] = useState('MENU'); 
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);
  const [error, setError] = useState('');

  const pos = useRef({ x: 800, y: 600 });
  const vel = useRef({ x: 0, y: 0 });
  const mousePosRaw = useRef({ x: 0, y: 0 });
  const lastShotTime = useRef(0);
  const keysPressed = useRef({});
  const isMouseDown = useRef(false);
  const gameLoopRef = useRef(null);
  const lastUpdateToDb = useRef(0);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = "https://cdn.tailwindcss.com";
    document.head.appendChild(script);

    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) { console.error("Auth error:", err); }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user || !lobbyCode || gameState === 'MENU') return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const unsub = onSnapshot(lobbyRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setLobbyData(data);
        if (data.status === 'PLAYING' && gameState === 'LOBBY') {
          setGameState('PLAYING');
          const myStartPos = data.players?.[user.uid] || { x: 800, y: 600 };
          pos.current = { x: myStartPos.x, y: myStartPos.y };
        }
        if (gameState === 'PLAYING' && data.players?.[user.uid]?.alive === false) {
          setGameState('DEAD');
        }
      }
    }, (err) => console.error("Firestore error:", err));
    return () => unsub();
  }, [user, lobbyCode, gameState]);

  useEffect(() => {
    if (gameState === 'PLAYING') {
      gameLoopRef.current = requestAnimationFrame(gameLoop);
    }
    return () => { if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current); };
  }, [gameState]);

  const gameLoop = () => {
    const cameraX = pos.current.x - VIEWPORT_W / 2;
    const cameraY = pos.current.y - VIEWPORT_H / 2;
    const worldMouseX = mousePosRaw.current.x + cameraX;
    const worldMouseY = mousePosRaw.current.y + cameraY;

    // 1. Beweging
    const dx = worldMouseX - pos.current.x;
    const dy = worldMouseY - pos.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 20) {
      vel.current.x += (dx / dist) * ACCELERATION;
      vel.current.y += (dy / dist) * ACCELERATION;
    }

    vel.current.x *= FRICTION;
    vel.current.y *= FRICTION;

    const currentSpeed = Math.sqrt(vel.current.x**2 + vel.current.y**2);
    if (currentSpeed > MAX_SPEED) {
      vel.current.x = (vel.current.x / currentSpeed) * MAX_SPEED;
      vel.current.y = (vel.current.y / currentSpeed) * MAX_SPEED;
    }

    // 2. Sliding Collision
    let nextX = pos.current.x + vel.current.x;
    let nextY = pos.current.y + vel.current.y;
    const r = 18; 

    let collX = false;
    for (let obs of OBSTACLES) {
      if (nextX + r > obs.x && nextX - r < obs.x + obs.w && 
          pos.current.y + r > obs.y && pos.current.y - r < obs.y + obs.h) {
        collX = true; break;
      }
    }
    if (!collX && nextX > r && nextX < MAP_WIDTH - r) pos.current.x = nextX;
    else vel.current.x = 0;

    let collY = false;
    for (let obs of OBSTACLES) {
      if (pos.current.x + r > obs.x && pos.current.x - r < obs.x + obs.w && 
          nextY + r > obs.y && nextY - r < obs.y + obs.h) {
        collY = true; break;
      }
    }
    if (!collY && nextY > r && nextY < MAP_HEIGHT - r) pos.current.y = nextY;
    else vel.current.y = 0;

    // 3. Schieten
    if ((keysPressed.current[' '] || isMouseDown.current) && Date.now() - lastShotTime.current > RELOAD_TIME) {
      fireBullet(worldMouseX, worldMouseY);
    }

    // 4. Bullet Hit Check & Cleanup (Local filter for performance)
    if (lobbyData?.bullets) {
      const now = Date.now();
      lobbyData.bullets.forEach(bullet => {
        if (bullet.ownerId !== user.uid && (now - bullet.createdAt < BULLET_LIFESPAN)) {
          const age = (now - bullet.createdAt) / 1000;
          const bx = bullet.x + (bullet.vx * age * 60);
          const by = bullet.y + (bullet.vy * age * 60);
          
          // Check muur impact voor kogel in geheugen
          let hitMuur = false;
          for(let o of OBSTACLES) { if (isPointInRect(bx, by, o)) hitMuur = true; }
          
          if (!hitMuur) {
            const d = Math.sqrt((bx - pos.current.x)**2 + (by - pos.current.y)**2);
            if (d < 22) handleDeath();
          }
        }
      });
    }

    // 5. Sync & Bullet Cleanup (Slechts af en toe om lag te voorkomen)
    const now = Date.now();
    if (now - lastUpdateToDb.current > 50) {
      syncGame();
      lastUpdateToDb.current = now;
    }

    gameLoopRef.current = requestAnimationFrame(gameLoop);
  };

  const syncGame = async () => {
    if (!user || !lobbyCode) return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    
    const updates = {
      [`players.${user.uid}.x`]: pos.current.x,
      [`players.${user.uid}.y`]: pos.current.y,
    };

    // Alleen kogel-opruiming doen als we eigenaar zijn of om de zoveel tijd
    // Voor nu simpel: we voegen alleen toe via fireBullet en filteren bij het tekenen.
    await updateDoc(lobbyRef, updates);
  };

  const fireBullet = async (targetX, targetY) => {
    lastShotTime.current = Date.now();
    const dx = targetX - pos.current.x;
    const dy = targetY - pos.current.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    
    const bullet = {
      id: Math.random().toString(36).substring(7),
      ownerId: user.uid,
      x: pos.current.x,
      y: pos.current.y,
      vx: (dx/dist) * BULLET_SPEED,
      vy: (dy/dist) * BULLET_SPEED,
      createdAt: Date.now()
    };

    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    
    // Performance fix: Filter oude kogels uit de array voordat we de nieuwe toevoegen
    const now = Date.now();
    const activeBullets = (lobbyData?.bullets || []).filter(b => now - b.createdAt < BULLET_LIFESPAN);
    
    await updateDoc(lobbyRef, { 
      bullets: [...activeBullets, bullet] 
    });
  };

  const handleDeath = async () => {
    setGameState('DEAD');
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(lobbyRef, { [`players.${user.uid}.alive`]: false });
  };

  useEffect(() => {
    const handleKeyDown = (e) => { keysPressed.current[e.key] = true; };
    const handleKeyUp = (e) => { keysPressed.current[e.key] = false; };
    const handleMouseDown = (e) => { if(e.button === 0) isMouseDown.current = true; };
    const handleMouseUp = () => { isMouseDown.current = false; };
    const handleMouseMove = (e) => {
      const area = document.getElementById('game-viewport');
      if (area) {
        const rect = area.getBoundingClientRect();
        mousePosRaw.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  const joinLobby = async () => {
    if (!playerName || !lobbyCode) return setError("Naam en code verplicht!");
    const startPos = findSafeSpawn();
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await setDoc(lobbyRef, {
      status: 'WAITING',
      bullets: [],
      players: { [user.uid]: { name: playerName, alive: true, x: startPos.x, y: startPos.y } }
    }, { merge: true });
    setGameState('LOBBY');
  };

  const startSpel = async () => {
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const newPlayers = { ...lobbyData.players };
    Object.keys(newPlayers).forEach(id => {
        const safe = findSafeSpawn();
        newPlayers[id].alive = true;
        newPlayers[id].x = safe.x;
        newPlayers[id].y = safe.y;
    });
    await updateDoc(lobbyRef, { status: 'PLAYING', bullets: [], players: newPlayers });
  };

  const getLaserEnd = () => {
    const cameraX = pos.current.x - VIEWPORT_W / 2;
    const cameraY = pos.current.y - VIEWPORT_H / 2;
    const worldMouseX = mousePosRaw.current.x + cameraX;
    const worldMouseY = mousePosRaw.current.y + cameraY;
    const dx = worldMouseX - pos.current.x;
    const dy = worldMouseY - pos.current.y;
    const angle = Math.atan2(dy, dx);
    let currX = pos.current.x;
    let currY = pos.current.y;
    for (let i = 0; i < 500; i += 5) {
      currX += Math.cos(angle) * 5;
      currY += Math.sin(angle) * 5;
      for (let obs of OBSTACLES) { if (isPointInRect(currX, currY, obs)) return { x: currX, y: currY }; }
      if (currX < 0 || currX > MAP_WIDTH || currY < 0 || currY > MAP_HEIGHT) return { x: currX, y: currY };
    }
    return { x: currX, y: currY };
  };

  if (gameState === 'MENU') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-white p-4">
        <div className="bg-slate-900 p-10 rounded-[2.5rem] shadow-2xl w-full max-w-md text-center border-b-8 border-emerald-900/50">
          <Crosshair size={60} className="text-emerald-400 mx-auto mb-6 animate-pulse" />
          <h1 className="text-6xl font-black mb-8 text-emerald-400 italic tracking-tighter uppercase">Boom.io</h1>
          <div className="space-y-4">
            <input className="w-full bg-slate-800 p-5 rounded-2xl border-2 border-slate-700 text-xl text-white outline-none focus:border-emerald-500" placeholder="NAAM" value={playerName} onChange={e => setPlayerName(e.target.value)} />
            <input className="w-full bg-slate-800 p-5 rounded-2xl border-2 border-slate-700 text-xl text-white outline-none focus:border-emerald-500 uppercase" placeholder="CODE" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
            <button onClick={joinLobby} className="w-full bg-emerald-500 py-5 rounded-2xl font-black text-2xl hover:bg-emerald-400 text-slate-900 uppercase active:translate-y-1 transition-all shadow-[0_8px_0_rgb(16,185,129)]">Start</button>
          </div>
        </div>
      </div>
    );
  }

  if (gameState === 'LOBBY') {
    const spelers = lobbyData?.players ? Object.values(lobbyData.players) : [];
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-white p-4">
        <div className="bg-slate-900 p-10 rounded-[2.5rem] shadow-2xl w-full max-w-md text-center">
          <h2 className="text-3xl font-black mb-8 text-slate-400 uppercase">Lobby: <span className="text-emerald-400">{lobbyCode}</span></h2>
          <div className="space-y-3 mb-10">
            {spelers.map((p, i) => (
              <div key={i} className="bg-slate-800 p-4 rounded-2xl flex items-center justify-between border border-slate-700">
                <span className="font-bold text-lg">{p.name}</span>
                <span className="text-[10px] font-black bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full uppercase tracking-tighter">Verbonden</span>
              </div>
            ))}
          </div>
          <button onClick={startSpel} className="w-full bg-blue-500 py-5 rounded-2xl font-black text-xl hover:bg-blue-400 text-white uppercase shadow-[0_8px_0_rgb(59,130,246)]">Start Match</button>
        </div>
      </div>
    );
  }

  const cameraX = pos.current.x - VIEWPORT_W / 2;
  const cameraY = pos.current.y - VIEWPORT_H / 2;
  const laser = getLaserEnd();

  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col items-center justify-center overflow-hidden cursor-none select-none p-4 font-sans">
      <div id="game-viewport" className="relative bg-slate-900 border-[8px] border-slate-800 shadow-2xl overflow-hidden rounded-xl" style={{ width: VIEWPORT_W, height: VIEWPORT_H }}>
        <div className="absolute transition-transform duration-75" style={{ transform: `translate(${-cameraX}px, ${-cameraY}px)` }}>
          <div className="absolute border-4 border-emerald-500/10 pointer-events-none" style={{ width: MAP_WIDTH, height: MAP_HEIGHT }} />
          
          <svg className="absolute inset-0 pointer-events-none z-10" style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}>
              <line x1={pos.current.x} y1={pos.current.y} x2={laser.x} y2={laser.y} stroke="rgba(255, 50, 50, 0.3)" strokeWidth="2" strokeDasharray="6,4" />
              <circle cx={laser.x} cy={laser.y} r="4" fill="#ff4444" />
          </svg>

          <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '100px 100px', width: MAP_WIDTH, height: MAP_HEIGHT }} />

          {OBSTACLES.map((o, i) => (
            <div key={i} className="absolute bg-slate-800 border-2 border-slate-700 shadow-inner rounded-lg overflow-hidden" style={{ left: o.x, top: o.y, width: o.w, height: o.h }}>
               <div className="w-full h-full opacity-10 bg-[repeating-linear-gradient(45deg,_#fff,_#fff_10px,_transparent_10px,_transparent_20px)]" />
            </div>
          ))}

          {lobbyData?.players && Object.entries(lobbyData.players).map(([id, p]) => {
            if (!p.alive) return null;
            const isMe = id === user?.uid;
            const x = isMe ? pos.current.x : (p.x || 0);
            const y = isMe ? pos.current.y : (p.y || 0);
            const reloadProgress = Math.min(100, ((Date.now() - lastShotTime.current) / RELOAD_TIME) * 100);

            return (
              <div key={id} className="absolute z-20" style={{ left: x - 20, top: y - 20, width: 40, height: 40 }}>
                <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-3 py-1 bg-slate-900/90 rounded-lg text-[10px] font-black uppercase text-white border border-white/10 shadow-lg">{p.name}</div>
                {isMe && (
                  <div className="absolute -top-4 left-2 right-2 h-1.5 bg-slate-800 rounded-full overflow-hidden border border-white/5">
                    <div className="h-full bg-emerald-400" style={{ width: `${reloadProgress}%` }} />
                  </div>
                )}
                <div className={`w-full h-full rounded-xl border-4 flex items-center justify-center shadow-xl ${isMe ? 'bg-blue-600 border-blue-400' : 'bg-rose-600 border-rose-400'}`}>
                  <Shield size={20} className="text-white/30" />
                </div>
              </div>
            );
          })}

          {lobbyData?.bullets?.map(b => {
            const age = (Date.now() - b.createdAt) / 1000;
            if (Date.now() - b.createdAt > BULLET_LIFESPAN) return null;
            const curX = b.x + (b.vx * age * 60);
            const curY = b.y + (b.vy * age * 60);
            
            for(let o of OBSTACLES) { if (isPointInRect(curX, curY, o)) return null; }

            return (
              <div key={b.id} className="absolute bg-white rounded-full w-2.5 h-2.5 z-30 shadow-[0_0_10px_#fff]" 
                style={{ left: curX - 1.25, top: curY - 1.25 }} />
            );
          })}
        </div>

        <div className="absolute top-4 right-4 w-32 h-24 bg-slate-900/80 backdrop-blur-sm border-2 border-slate-700 rounded-lg overflow-hidden z-50">
           <div className="relative w-full h-full">
              <div className="absolute w-2 h-2 bg-blue-500 rounded-full" style={{ left: (pos.current.x / MAP_WIDTH) * 100 + '%', top: (pos.current.y / MAP_HEIGHT) * 100 + '%' }} />
              {lobbyData?.players && Object.entries(lobbyData.players).map(([id, p]) => (
                id !== user?.uid && p.alive && (
                  <div key={id} className="absolute w-1.5 h-1.5 bg-rose-500 rounded-full" style={{ left: (p.x / MAP_WIDTH) * 100 + '%', top: (p.y / MAP_HEIGHT) * 100 + '%' }} />
                )
              ))}
              {OBSTACLES.map((o, i) => (
                <div key={i} className="absolute bg-slate-600/50" style={{ left: (o.x / MAP_WIDTH) * 100 + '%', top: (o.y / MAP_HEIGHT) * 100 + '%', width: (o.w / MAP_WIDTH) * 100 + '%', height: (o.h / MAP_HEIGHT) * 100 + '%' }} />
              ))}
           </div>
        </div>

        <div className="absolute z-[100] pointer-events-none" style={{ left: mousePosRaw.current.x - 12, top: mousePosRaw.current.y - 12 }}>
            <div className="w-6 h-6 border-2 border-emerald-400 rounded-full flex items-center justify-center">
                <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
            </div>
        </div>
      </div>

      {gameState === 'DEAD' && (
        <div className="absolute inset-0 bg-slate-950/95 flex items-center justify-center z-[200] p-6">
          <div className="text-center p-12 bg-slate-900 rounded-[3rem] border-b-8 border-rose-600 shadow-2xl max-w-sm w-full">
            <Skull size={60} className="text-rose-500 mx-auto mb-6" />
            <h2 className="text-5xl font-black mb-2 text-white italic uppercase tracking-tighter">Game Over</h2>
            <button onClick={() => window.location.reload()} className="bg-white text-slate-950 px-10 py-5 rounded-2xl font-black text-xl hover:bg-emerald-400 transition-all flex items-center justify-center gap-3 w-full mt-8 uppercase">Herstart</button>
          </div>
        </div>
      )}
    </div>
  );
}