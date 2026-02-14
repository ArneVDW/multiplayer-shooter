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

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'mijn-shooter-game';

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// Game Instellingen
const ACCELERATION = 0.6;
const FRICTION = 0.92;
const MAX_SPEED = 5;
const BULLET_SPEED = 12;
const RELOAD_TIME = 400; 
const PLAYER_SIZE = 40;
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;

const OBSTACLES = [
  { x: 150, y: 150, w: 120, h: 120 },
  { x: 530, y: 80, w: 80, h: 280 },
  { x: 300, y: 380, w: 300, h: 50 },
  { x: 80, y: 420, w: 100, h: 100 },
];

// Helper om te kijken of een punt in een obstakel zit
function isPointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [gameState, setGameState] = useState('MENU'); 
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);
  const [error, setError] = useState('');

  // Physics refs
  const pos = useRef({ x: 400, y: 300 });
  const vel = useRef({ x: 0, y: 0 });
  const mousePos = useRef({ x: 400, y: 300 });
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
    // 1. Bereken gewenste richting op basis van muis
    const dx = mousePos.current.x - pos.current.x;
    const dy = mousePos.current.y - pos.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 15) {
      vel.current.x += (dx / dist) * ACCELERATION;
      vel.current.y += (dy / dist) * ACCELERATION;
    }

    // 2. Pas wrijving toe en beperk snelheid
    vel.current.x *= FRICTION;
    vel.current.y *= FRICTION;

    const currentSpeed = Math.sqrt(vel.current.x**2 + vel.current.y**2);
    if (currentSpeed > MAX_SPEED) {
      vel.current.x = (vel.current.x / currentSpeed) * MAX_SPEED;
      vel.current.y = (vel.current.y / currentSpeed) * MAX_SPEED;
    }

    // 3. SLIDING COLLISION LOGICA
    // We checken X en Y apart zodat de speler kan "glijden" langs muren
    let nextX = pos.current.x + vel.current.x;
    let nextY = pos.current.y + vel.current.y;

    // Check X beweging
    let collisionX = false;
    for (let obs of OBSTACLES) {
      if (nextX + 18 > obs.x && nextX - 18 < obs.x + obs.w && 
          pos.current.y + 18 > obs.y && pos.current.y - 18 < obs.y + obs.h) {
        collisionX = true;
        break;
      }
    }
    if (!collisionX && nextX > 20 && nextX < MAP_WIDTH - 20) {
      pos.current.x = nextX;
    } else {
      vel.current.x = 0; // Stop horizontale vaart bij botsing
    }

    // Check Y beweging
    let collisionY = false;
    for (let obs of OBSTACLES) {
      if (pos.current.x + 18 > obs.x && pos.current.x - 18 < obs.x + obs.w && 
          nextY + 18 > obs.y && nextY - 18 < obs.y + obs.h) {
        collisionY = true;
        break;
      }
    }
    if (!collisionY && nextY > 20 && nextY < MAP_HEIGHT - 20) {
      pos.current.y = nextY;
    } else {
      vel.current.y = 0; // Stop verticale vaart bij botsing
    }

    // 4. Schieten
    if ((keysPressed.current[' '] || isMouseDown.current) && Date.now() - lastShotTime.current > RELOAD_TIME) {
      fireBullet();
    }

    // 5. Bullet Hit Detectie
    if (lobbyData?.bullets) {
      lobbyData.bullets.forEach(bullet => {
        if (bullet.ownerId !== user.uid) {
          const age = (Date.now() - bullet.createdAt) / 1000;
          const bx = bullet.x + (bullet.vx * age * 60);
          const by = bullet.y + (bullet.vy * age * 60);
          
          const d = Math.sqrt((bx - pos.current.x)**2 + (by - pos.current.y)**2);
          if (d < 22) handleDeath();
        }
      });
    }

    // 6. Sync naar DB
    const now = Date.now();
    if (now - lastUpdateToDb.current > 45) {
      syncPlayer();
      lastUpdateToDb.current = now;
    }

    gameLoopRef.current = requestAnimationFrame(gameLoop);
  };

  // Laser Sight Berekening: Vind het eerste punt van inslag (muur of map-rand)
  const getLaserEnd = () => {
    const dx = mousePos.current.x - pos.current.x;
    const dy = mousePos.current.y - pos.current.y;
    const angle = Math.atan2(dy, dx);
    
    let step = 2;
    let currX = pos.current.x;
    let currY = pos.current.y;
    
    // Scan vooruit tot we iets raken
    for (let i = 0; i < 400; i++) {
      currX += Math.cos(angle) * step;
      currY += Math.sin(angle) * step;
      
      // Check muren
      for (let obs of OBSTACLES) {
        if (isPointInRect(currX, currY, obs)) return { x: currX, y: currY };
      }
      
      // Check grenzen
      if (currX < 0 || currX > MAP_WIDTH || currY < 0 || currY > MAP_HEIGHT) {
        return { x: currX, y: currY };
      }
    }
    return { x: currX, y: currY };
  };

  const handleDeath = async () => {
    setGameState('DEAD');
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(lobbyRef, { [`players.${user.uid}.alive`]: false });
  };

  const syncPlayer = async () => {
    if (!user || !lobbyCode) return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(lobbyRef, {
      [`players.${user.uid}.x`]: pos.current.x,
      [`players.${user.uid}.y`]: pos.current.y,
    });
  };

  const fireBullet = async () => {
    lastShotTime.current = Date.now();
    const dx = mousePos.current.x - pos.current.x;
    const dy = mousePos.current.y - pos.current.y;
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
    await updateDoc(lobbyRef, { bullets: arrayUnion(bullet) });
  };

  useEffect(() => {
    const handleKeyDown = (e) => { keysPressed.current[e.key] = true; };
    const handleKeyUp = (e) => { keysPressed.current[e.key] = false; };
    const handleMouseDown = (e) => { if(e.button === 0) isMouseDown.current = true; };
    const handleMouseUp = () => { isMouseDown.current = false; };
    const handleMouseMove = (e) => {
      const area = document.getElementById('game-area');
      if (area) {
        const rect = area.getBoundingClientRect();
        mousePos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
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
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await setDoc(lobbyRef, {
      status: 'WAITING',
      bullets: [],
      players: { [user.uid]: { name: playerName, alive: true, x: 400, y: 300 } }
    }, { merge: true });
    setGameState('LOBBY');
  };

  const startSpel = async () => {
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const newPlayers = { ...lobbyData.players };
    Object.keys(newPlayers).forEach(id => {
        newPlayers[id].alive = true;
        newPlayers[id].x = Math.random() * 500 + 150;
        newPlayers[id].y = Math.random() * 300 + 150;
    });
    await updateDoc(lobbyRef, { status: 'PLAYING', bullets: [], players: newPlayers });
  };

  if (gameState === 'MENU') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-white font-sans p-4">
        <div className="bg-slate-900 p-10 rounded-[2.5rem] shadow-[0_20px_50px_rgba(16,185,129,0.2)] w-full max-w-md border-b-8 border-slate-800 text-center">
          <div className="bg-emerald-500/10 w-24 h-24 rounded-3xl flex items-center justify-center mx-auto mb-6 border-2 border-emerald-500/20">
             <Crosshair size={48} className="text-emerald-400 animate-spin-slow" />
          </div>
          <h1 className="text-6xl font-black mb-10 text-emerald-400 italic tracking-tighter">BOOM.IO</h1>
          <div className="space-y-4">
            <input className="w-full bg-slate-800 p-5 rounded-2xl border-2 border-slate-700 text-xl outline-none focus:border-emerald-500 text-white placeholder-slate-600 transition-all" placeholder="JOUW NAAM" value={playerName} onChange={e => setPlayerName(e.target.value)} />
            <input className="w-full bg-slate-800 p-5 rounded-2xl border-2 border-slate-700 text-xl outline-none focus:border-emerald-500 uppercase font-mono text-white placeholder-slate-600 transition-all" placeholder="LOBBY CODE" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
            <button onClick={joinLobby} className="w-full bg-emerald-500 py-5 rounded-2xl font-black text-2xl hover:bg-emerald-400 active:translate-y-1 transition-all shadow-[0_8px_0_rgb(16,185,129)] text-slate-900 mt-4 uppercase">Gevecht Starten</button>
            {error && <p className="text-rose-400 font-bold mt-2">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  if (gameState === 'LOBBY') {
    const spelers = lobbyData?.players ? Object.values(lobbyData.players) : [];
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-white p-4">
        <div className="bg-slate-900 p-10 rounded-[2.5rem] shadow-2xl w-full max-w-md border-b-8 border-slate-800 text-center">
          <h2 className="text-3xl font-black mb-8 uppercase tracking-widest text-slate-400">LOBBY <span className="text-emerald-400">{lobbyCode}</span></h2>
          <div className="space-y-3 mb-10">
            {spelers.map((p, i) => (
              <div key={i} className="bg-slate-800 p-4 rounded-2xl flex items-center justify-between border border-slate-700">
                <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
                    <span className="font-bold text-lg text-slate-200">{p.name}</span>
                </div>
                <span className="text-[10px] font-black bg-slate-700 text-slate-400 px-3 py-1 rounded-full uppercase">Ready</span>
              </div>
            ))}
          </div>
          <button onClick={startSpel} className="w-full bg-blue-500 py-5 rounded-2xl font-black text-xl hover:bg-blue-400 flex items-center justify-center gap-3 shadow-[0_8px_0_rgb(59,130,246)] text-white active:translate-y-1 transition-all">
            <Play fill="currentColor" /> START MATCH
          </button>
        </div>
      </div>
    );
  }

  const laserEnd = getLaserEnd();

  return (
    <div className="fixed inset-0 bg-slate-950 flex items-center justify-center overflow-hidden cursor-none select-none">
      <div 
        id="game-area" 
        className="relative bg-slate-900 border-[12px] border-slate-800 shadow-[0_0_100px_rgba(0,0,0,0.5)] overflow-hidden rounded-sm" 
        style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}
      >
        {/* Richtlijn (Laser Sight) */}
        <svg className="absolute inset-0 pointer-events-none z-10 w-full h-full">
            <line 
                x1={pos.current.x} y1={pos.current.y} 
                x2={laserEnd.x} y2={laserEnd.y} 
                stroke="rgba(255, 50, 50, 0.4)" strokeWidth="1.5"
            />
            {/* Impact dot op de laser */}
            <circle cx={laserEnd.x} cy={laserEnd.y} r="3" fill="rgba(255, 50, 50, 0.8)" />
        </svg>

        {/* Custom Muis Cursor */}
        <div className="absolute z-50 pointer-events-none" style={{ left: mousePos.current.x - 10, top: mousePos.current.y - 10 }}>
            <div className="w-5 h-5 border-2 border-emerald-400 rounded-full flex items-center justify-center opacity-80">
                <div className="w-1 h-1 bg-emerald-400 rounded-full" />
            </div>
        </div>

        {/* Grid achtergrond */}
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'linear-gradient(#fff 2px, transparent 2px), linear-gradient(90deg, #fff 2px, transparent 2px)', backgroundSize: '50px 50px' }} />

        {/* Barrières */}
        {OBSTACLES.map((o, i) => (
          <div key={i} className="absolute bg-slate-800 border-2 border-slate-700/50 rounded-xl overflow-hidden shadow-lg" style={{ left: o.x, top: o.y, width: o.w, height: o.h }}>
              <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_center,_#475569_1px,_transparent_1px)] bg-[length:10px_10px]" />
          </div>
        ))}

        {/* Spelers */}
        {lobbyData?.players && Object.entries(lobbyData.players).map(([id, p]) => {
          if (!p.alive) return null;
          const isMe = id === user?.uid;
          const x = isMe ? pos.current.x : (p.x || 0);
          const y = isMe ? pos.current.y : (p.y || 0);
          const reloadProgress = Math.min(100, ((Date.now() - lastShotTime.current) / RELOAD_TIME) * 100);

          return (
            <div key={id} className="absolute z-20 transition-all duration-75" style={{ left: x - 20, top: y - 20, width: 40, height: 40 }}>
              <div className="absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap px-3 py-1 bg-slate-900/80 backdrop-blur-sm rounded-lg text-[10px] font-black uppercase text-white border border-white/10 shadow-xl">{p.name}</div>
              
              {isMe && (
                <div className="absolute -top-4 left-2 right-2 h-1.5 bg-slate-800 rounded-full overflow-hidden border border-white/5">
                  <div className="h-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" style={{ width: `${reloadProgress}%` }} />
                </div>
              )}

              <div className={`w-full h-full rounded-2xl border-4 flex items-center justify-center shadow-2xl ${isMe ? 'bg-blue-600 border-blue-400 shadow-blue-500/20' : 'bg-rose-600 border-rose-400 shadow-rose-500/20'}`}>
                <Shield size={22} className="text-white/30" />
              </div>
            </div>
          );
        })}

        {/* Kogels */}
        {lobbyData?.bullets?.map(b => {
          const age = (Date.now() - b.createdAt) / 1000;
          if (age > 1.2) return null;
          const curX = b.x + (b.vx * age * 60);
          const curY = b.y + (b.vy * age * 60);
          
          // Bullet stopt bij muur
          let hitObs = false;
          for(let o of OBSTACLES) {
              if (isPointInRect(curX, curY, o)) hitObs = true;
          }
          if (hitObs) return null;

          return (
            <div key={b.id} className="absolute bg-white rounded-full w-2 h-2 z-30 shadow-[0_0_15px_#fff,0_0_5px_#facc15]" 
              style={{ left: curX - 1, top: curY - 1 }} />
          );
        })}
      </div>

      {/* Death Screen */}
      {gameState === 'DEAD' && (
        <div className="absolute inset-0 bg-slate-950/95 backdrop-blur-md flex items-center justify-center z-50 p-6 animate-in fade-in duration-500">
          <div className="text-center p-12 bg-slate-900 rounded-[3rem] border-b-8 border-rose-600 shadow-2xl max-w-sm w-full">
            <div className="bg-rose-500/10 w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-8 border-2 border-rose-500/20">
                <Skull size={50} className="text-rose-500" />
            </div>
            <h2 className="text-5xl font-black mb-2 text-white italic tracking-tighter uppercase">Uitgeschakeld</h2>
            <p className="text-slate-500 font-bold mb-10 tracking-widest uppercase text-sm">Beter mikken de volgende keer!</p>
            <button onClick={() => window.location.reload()} className="bg-white text-slate-950 px-10 py-5 rounded-2xl font-black text-xl hover:bg-emerald-400 transition-all flex items-center justify-center gap-3 mx-auto shadow-[0_8px_0_#cbd5e1] active:translate-y-1 active:shadow-none w-full">
              <RotateCcw size={24} /> NOG EEN KEER
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// CSS toevoeging voor soepele animaties
const style = document.createElement('style');
style.textContent = `
  @keyframes spin-slow {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .animate-spin-slow {
    animation: spin-slow 8s linear infinite;
  }
`;
document.head.appendChild(style);