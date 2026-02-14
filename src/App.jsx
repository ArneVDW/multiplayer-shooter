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
  arrayUnion,
  arrayRemove,
  getDoc
} from 'firebase/firestore';
import { Crosshair, Shield, Play, Skull, RotateCcw } from 'lucide-react';

// --- CONFIGURATIE ---
// Vervang deze door jouw eigen Firebase config uit de Deployment Handleiding
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDw-WSx1oYTHzadXUB7csmKNhZlO0RTw6Y",
  authDomain: "multiplayer-shooter-c0b9f.firebaseapp.com",
  projectId: "multiplayer-shooter-c0b9f",
  storageBucket: "multiplayer-shooter-c0b9f.firebasestorage.app",
  messagingSenderId: "773037810608",
  appId: "1:773037810608:web:f8b22fc68fa1e0c34f2c75"
};
const APP_ID = 'multiplayer-shooter'; // Mag je zelf verzinnen

// Initialiseer Firebase
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// Game Instellingen
const PLAYER_SPEED = 4;
const BULLET_SPEED = 8;
const RELOAD_TIME = 1000; 
const PLAYER_SIZE = 40;
const BULLET_SIZE = 10;
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;

// Hindernissen op de kaart
const OBSTACLES = [
  { x: 200, y: 200, w: 100, h: 100 },
  { x: 500, y: 100, w: 50, h: 200 },
  { x: 400, y: 400, w: 200, h: 50 },
  { x: 100, y: 450, w: 100, h: 100 },
];

// Functie om te kijken of een cirkel een rechthoek raakt
function checkCircleRectCollision(circle, rect) {
  let testX = circle.x;
  let testY = circle.y;

  if (circle.x < rect.x) testX = rect.x;
  else if (circle.x > rect.x + rect.w) testX = rect.x + rect.w;
  
  if (circle.y < rect.y) testY = rect.y;
  else if (circle.y > rect.y + rect.h) testY = rect.y + rect.h;

  let distX = circle.x - testX;
  let distY = circle.y - testY;
  let distance = Math.sqrt((distX * distX) + (distY * distY));

  return distance <= circle.r;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [gameState, setGameState] = useState('MENU'); 
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);
  const [error, setError] = useState('');

  const localPos = useRef({ x: 50, y: 50 });
  const mousePos = useRef({ x: 0, y: 0 });
  const lastShotTime = useRef(0);
  const keysPressed = useRef({});
  const gameLoopRef = useRef(null);
  const lastUpdateToDb = useRef(0);

  // Inloggen
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        console.error("Inloggen mislukt", err);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // Lobby updates bijhouden
  useEffect(() => {
    if (!user || !lobbyCode || gameState === 'MENU') return;

    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const unsub = onSnapshot(lobbyRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setLobbyData(data);
        if (data.status === 'PLAYING' && gameState === 'LOBBY') {
          setGameState('PLAYING');
          localPos.current = { x: Math.random() * 700 + 50, y: Math.random() * 500 + 50 };
          requestAnimationFrame(gameLoop);
        }
      }
    });

    return () => unsub();
  }, [user, lobbyCode, gameState]);

  const gameLoop = () => {
    if (gameState !== 'PLAYING' && gameState !== 'DEAD') return;
    
    // Beweging richting muis
    const dx = mousePos.current.x - localPos.current.x;
    const dy = mousePos.current.y - localPos.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 5) {
      const moveX = (dx / distance) * PLAYER_SPEED;
      const moveY = (dy / distance) * PLAYER_SPEED;
      let nextX = Math.max(20, Math.min(780, localPos.current.x + moveX));
      let nextY = Math.max(20, Math.min(580, localPos.current.y + moveY));

      let hitsObstacle = false;
      for (let obs of OBSTACLES) {
        if (checkCircleRectCollision({ x: nextX, y: nextY, r: 20 }, obs)) {
          hitsObstacle = true;
          break;
        }
      }
      if (!hitsObstacle) {
        localPos.current = { x: nextX, y: nextY };
      }
    }

    // Schieten met Spatiebalk
    if (keysPressed.current[' '] && Date.now() - lastShotTime.current > RELOAD_TIME) {
      fireBullet();
    }

    // Database synchronisatie
    const now = Date.now();
    if (now - lastUpdateToDb.current > 100) {
      syncPlayer();
      lastUpdateToDb.current = now;
    }

    if (gameState === 'PLAYING') {
      gameLoopRef.current = requestAnimationFrame(gameLoop);
    }
  };

  const syncPlayer = async () => {
    if (!user || !lobbyCode) return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(lobbyRef, {
      [`players.${user.uid}.x`]: localPos.current.x,
      [`players.${user.uid}.y`]: localPos.current.y,
      [`players.${user.uid}.lastSeen`]: Date.now()
    });
  };

  const fireBullet = async () => {
    lastShotTime.current = Date.now();
    const dx = mousePos.current.x - localPos.current.x;
    const dy = mousePos.current.y - localPos.current.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    
    const bullet = {
      id: Math.random().toString(36).substring(7),
      ownerId: user.uid,
      x: localPos.current.x,
      y: localPos.current.y,
      vx: (dx/dist) * BULLET_SPEED,
      vy: (dy/dist) * BULLET_SPEED,
      createdAt: Date.now()
    };

    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(lobbyRef, { bullets: arrayUnion(bullet) });
  };

  useEffect(() => {
    const handleKeyDown = (e) => keysPressed.current[e.key] = true;
    const handleKeyUp = (e) => keysPressed.current[e.key] = false;
    const handleMouseMove = (e) => {
      const area = document.getElementById('game-area');
      if (area) {
        const rect = area.getBoundingClientRect();
        mousePos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  const joinLobby = async () => {
    if (!playerName || !lobbyCode) return setError("Vul alles in!");
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await setDoc(lobbyRef, {
      status: 'WAITING',
      bullets: [],
      players: {
        [user.uid]: { name: playerName, alive: true, x: 100, y: 100 }
      }
    }, { merge: true });
    setGameState('LOBBY');
  };

  const startSpel = async () => {
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(lobbyRef, { status: 'PLAYING', bullets: [] });
  };

  // --- RENDERING ---
  if (gameState === 'MENU') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 text-white p-4">
        <div className="bg-slate-800 p-8 rounded-2xl shadow-xl w-full max-w-md border border-slate-700">
          <h1 className="text-4xl font-black text-center mb-8 text-emerald-400 flex items-center justify-center gap-3">
            <Crosshair size={40} /> BOOM.IO
          </h1>
          <input 
            className="w-full bg-slate-700 p-3 rounded-lg mb-4 border border-slate-600 outline-none focus:border-emerald-500"
            placeholder="Je Naam" 
            value={playerName} 
            onChange={e => setPlayerName(e.target.value)} 
          />
          <input 
            className="w-full bg-slate-700 p-3 rounded-lg mb-6 border border-slate-600 outline-none focus:border-emerald-500 uppercase font-mono"
            placeholder="Lobby Code" 
            value={lobbyCode} 
            onChange={e => setLobbyCode(e.target.value)} 
          />
          <button onClick={joinLobby} className="w-full bg-emerald-600 py-4 rounded-xl font-bold text-lg hover:bg-emerald-500 transition-colors">
            SPEEL NU
          </button>
        </div>
      </div>
    );
  }

  if (gameState === 'LOBBY') {
    const spelers = lobbyData?.players ? Object.values(lobbyData.players) : [];
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 text-white">
        <div className="bg-slate-800 p-8 rounded-2xl shadow-xl w-full max-w-md border border-slate-700 text-center">
          <h2 className="text-2xl font-bold mb-6">Lobby: <span className="text-emerald-400">{lobbyCode}</span></h2>
          <div className="space-y-2 mb-8">
            {spelers.map((p, i) => (
              <div key={i} className="bg-slate-700 p-3 rounded-lg flex items-center gap-3">
                <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
                <span className="font-medium">{p.name}</span>
              </div>
            ))}
          </div>
          <button onClick={startSpel} className="w-full bg-blue-600 py-4 rounded-xl font-bold text-lg hover:bg-blue-500 flex items-center justify-center gap-2">
            <Play size={20} /> START SPEL
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-screen bg-slate-950 flex items-center justify-center overflow-hidden">
      <div id="game-area" className="relative bg-slate-900 border-4 border-slate-800 overflow-hidden" style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}>
        {OBSTACLES.map((o, i) => (
          <div key={i} className="absolute bg-slate-700 border border-slate-600" style={{ left: o.x, top: o.y, width: o.w, height: o.h }} />
        ))}
        {lobbyData?.players && Object.entries(lobbyData.players).map(([id, p]) => {
          if (!p.alive) return null;
          const isMe = id === user?.uid;
          const x = isMe ? localPos.current.x : p.x;
          const y = isMe ? localPos.current.y : p.y;
          const reloadProgress = Math.min(100, ((Date.now() - lastShotTime.current) / RELOAD_TIME) * 100);

          return (
            <div key={id} className="absolute" style={{ left: x - 20, top: y - 20, width: 40, height: 40 }}>
              <div className="absolute -top-6 left-0 right-0 text-center text-[10px] font-bold uppercase truncate">{p.name}</div>
              {isMe && (
                <div className="absolute -top-2 left-0 right-0 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-400 transition-all duration-100" style={{ width: `${reloadProgress}%` }} />
                </div>
              )}
              <div className={`w-full h-full rounded-full border-4 flex items-center justify-center ${isMe ? 'bg-blue-600 border-blue-400' : 'bg-red-600 border-red-400'}`}>
                <Shield size={16} />
              </div>
            </div>
          );
        })}
        {lobbyData?.bullets?.map(b => {
          const age = (Date.now() - b.createdAt) / 1000;
          if (age > 1.5) return null;
          return (
            <div key={b.id} className="absolute bg-yellow-400 rounded-full w-2 h-2 shadow-[0_0_8px_#fbbf24]" 
              style={{ left: b.x + (b.vx * age * 60) - 4, top: b.y + (b.vy * age * 60) - 4 }} />
          );
        })}
      </div>
      {gameState === 'DEAD' && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-center items-center justify-center">
          <div className="text-center p-8 bg-slate-800 rounded-3xl border border-red-500/50">
            <Skull size={64} className="text-red-500 mx-auto mb-4" />
            <h2 className="text-3xl font-black mb-6">GAME OVER</h2>
            <button onClick={() => window.location.reload()} className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-emerald-400 transition-colors">
              OPNIEUW PROBEREN
            </button>
          </div>
        </div>
      )}
    </div>
  );
}