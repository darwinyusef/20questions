require('dotenv').config();
const express   = require('express');
const session   = require('express-session');
const Database  = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const swaggerUi = require('swagger-ui-express');

const app  = express();
const DATA = path.join(__dirname, 'data');

// ── Cargar configuración desde data/*.json ───────────────────────────
const PREGUNTAS   = JSON.parse(fs.readFileSync(path.join(DATA, 'preguntas.json'),   'utf8'));
const CORRECTAS   = JSON.parse(fs.readFileSync(path.join(DATA, 'respuestas.json'),  'utf8'));
const ESTUDIANTES = JSON.parse(fs.readFileSync(path.join(DATA, 'estudiantes.json'), 'utf8'));

const TOTAL      = PREGUNTAS.length;
const MINIMO     = Math.ceil(TOTAL * 0.6);
const MAX_TRAMPAS = 3;
const DURACION   = 45 * 60;   // segundos

// ── Utilidades ───────────────────────────────────────────────────────
const normalizar = s =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
     .toUpperCase().trim().replace(/\s+/g, ' ');

const genCodigo = () => crypto.randomBytes(3).toString('hex').toUpperCase();

// ── DB ───────────────────────────────────────────────────────────────
const DB_DIR  = process.env.DB_DIR || __dirname;
const DB_PATH = path.join(DB_DIR, 'infokey.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS estudiantes (
    id            INTEGER PRIMARY KEY,
    nombre        TEXT UNIQUE NOT NULL,
    documento     TEXT DEFAULT '',
    ultimo_acceso TEXT,
    bloqueado     INTEGER DEFAULT 0,
    anulado       INTEGER DEFAULT 0,
    completado    INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS progreso (
    estudiante_id      INTEGER NOT NULL,
    pregunta_id        INTEGER NOT NULL,
    letra              TEXT NOT NULL,
    fecha              TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (estudiante_id, pregunta_id),
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id)
  );
  CREATE TABLE IF NOT EXISTS sesion_activa (
    estudiante_id      INTEGER PRIMARY KEY,
    segundos_restantes INTEGER DEFAULT ${DURACION},
    iniciado           INTEGER DEFAULT 0,
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id)
  );
  CREATE TABLE IF NOT EXISTS bloqueos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    estudiante_id INTEGER NOT NULL,
    documento     TEXT,
    motivo        TEXT NOT NULL,
    fecha         TEXT DEFAULT (datetime('now','localtime')),
    codigo        TEXT NOT NULL,
    desbloqueado  INTEGER DEFAULT 0,
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id)
  );
  CREATE TABLE IF NOT EXISTS advertencias (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    estudiante_id INTEGER NOT NULL,
    tipo          TEXT NOT NULL,
    fecha         TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id)
  );
  CREATE TABLE IF NOT EXISTS resultados (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    estudiante_id   INTEGER NOT NULL UNIQUE,
    documento       TEXT,
    puntaje         INTEGER NOT NULL,
    total           INTEGER NOT NULL,
    aprobado        INTEGER NOT NULL,
    respuestas_json TEXT NOT NULL,
    fecha           TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id)
  );
`);

// Migraciones seguras para columnas nuevas
['bloqueado','anulado','completado'].forEach(c => {
    try { db.exec(`ALTER TABLE estudiantes ADD COLUMN ${c} INTEGER DEFAULT 0`); } catch {}
});
try { db.exec(`ALTER TABLE estudiantes ADD COLUMN documento TEXT DEFAULT ''`); } catch {}

// Seed desde data/estudiantes.json (INSERT OR IGNORE)
const upsertEst = db.prepare(`
  INSERT INTO estudiantes (id, nombre, documento)
  VALUES (@id, @nombre, @documento)
  ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre, documento=excluded.documento
`);
for (const e of ESTUDIANTES) upsertEst.run(e);

// ── SSE – clientes admin en escucha ─────────────────────────────────
const sseClients = new Set();

function sseEnviar(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(c => { try { c.write(msg); } catch {} });
}

// ── Swagger ──────────────────────────────────────────────────────────
const swaggerSpec = {
    openapi: '3.0.0',
    info: {
        title: 'Infokey – Evaluación ISO 27001',
        version: '2.0.0',
        description:
            '**Flujo estudiante:** `POST /ingresar` → `GET /api/progreso` → `POST /api/iniciar` → `POST /api/guardar` (c/respuesta) → `POST /api/validar`\n\n' +
            '**Flujo profesor:** `POST /api/admin/login` → `GET /api/admin/bloqueos/stream` (SSE) → `POST /api/admin/desbloquear/:id`\n\n' +
            '**Archivos de configuración editables:** `data/preguntas.json` · `data/respuestas.json` · `data/estudiantes.json`\n\n' +
            '**Reset BD:** elimina `infokey.db`; al reiniciar el servidor se recrea desde los JSON.',
    },
    tags: [
        { name: 'Auth',  description: 'Acceso de estudiantes' },
        { name: 'Quiz',  description: 'Cuestionario en curso' },
        { name: 'Admin', description: 'Panel del profesor' },
    ],
    paths: {
        '/ingresar': {
            post: {
                tags: ['Auth'],
                summary: 'Ingreso del estudiante',
                description:
                    'Valida **nombre** y, si tiene documento en `data/estudiantes.json`, también valida la **cédula**.\n\n' +
                    'Si el campo `documento` en el JSON está vacío (`""`), se acepta cualquier cédula.',
                requestBody: {
                    required: true,
                    content: { 'application/x-www-form-urlencoded': { schema: {
                        type: 'object', required: ['nombre','documento'],
                        properties: {
                            nombre:    { type: 'string', example: 'ORTIZ GOMEZ JUAN PABLO' },
                            documento: { type: 'string', example: '1002345678' },
                        }
                    }}}
                },
                responses: { 302: { description: '→ /cuestionario · /resultados (ya completó) · /?error=noregistrado · /?error=cedula' } }
            }
        },
        '/salir': {
            get: { tags: ['Auth'], summary: 'Cerrar sesión', responses: { 302: { description: '→ /' } } }
        },
        '/api/yo': {
            get: {
                tags: ['Auth'], summary: 'Datos del usuario en sesión',
                responses: {
                    200: { content: { 'application/json': { schema: { type: 'object',
                        properties: {
                            id:         { type: 'integer', example: 6 },
                            nombre:     { type: 'string',  example: 'ORTIZ GOMEZ JUAN PABLO' },
                            documento:  { type: 'string',  example: '1002345678' },
                            completado: { type: 'boolean', example: false },
                        }
                    }}}},
                    302: { description: 'Sin sesión' }
                }
            }
        },
        '/api/estado': {
            get: {
                tags: ['Quiz'], summary: 'Estado del estudiante',
                responses: { 200: { content: { 'application/json': { schema: { type: 'object',
                    properties: {
                        estado:  { type: 'string', enum: ['ok','bloqueado','anulado','completado'] },
                        bloqueo: { type: 'object', properties: { fecha: { type:'string' }, codigo: { type:'string' } } },
                        total:   { type: 'integer' },
                    }
                }}}}}
            }
        },
        '/api/preguntas': {
            get: {
                tags: ['Quiz'], summary: 'Preguntas sin respuestas correctas',
                responses: { 200: { description: 'Array de preguntas con opciones A–D y feedback. Sin campo correcta.' }, 403: { description: 'Ya completó' } }
            }
        },
        '/api/progreso': {
            get: {
                tags: ['Quiz'], summary: 'Progreso guardado del estudiante',
                description: 'Devuelve respuestas guardadas, segundos restantes e indicador de si ya inició. Permite retomar tras cerrar accidentalmente.',
                responses: { 200: { content: { 'application/json': { schema: { type: 'object',
                    properties: {
                        respuestas:        { type: 'object', example: { '1':'B','3':'C' } },
                        segundos_restantes:{ type: 'integer', example: 2134 },
                        iniciado:          { type: 'boolean', example: true },
                    }
                }}}}}
            }
        },
        '/api/iniciar': {
            post: {
                tags: ['Quiz'], summary: 'Marcar inicio del quiz (arranca el timer en servidor)',
                responses: { 200: { description: '{ ok: true }' } }
            }
        },
        '/api/guardar': {
            post: {
                tags: ['Quiz'], summary: 'Guardar una respuesta individual + tiempo restante',
                description: 'Se llama cada vez que el estudiante selecciona una opción. Persiste en BD para recuperación.',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
                    required: ['pregunta_id','letra','segundos_restantes'],
                    properties: {
                        pregunta_id:        { type: 'integer', example: 5 },
                        letra:              { type: 'string',  example: 'B' },
                        segundos_restantes: { type: 'integer', example: 2134 },
                    }
                }}}},
                responses: { 200: { description: '{ ok: true }' } }
            }
        },
        '/api/validar': {
            post: {
                tags: ['Quiz'], summary: 'Enviar y calificar todas las respuestas (una sola vez)',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
                    properties: { respuestas: { type: 'object', example: { '1':'B','2':'A' } } }
                }}}},
                responses: { 200: { description: '{ ok: true }' }, 403: { description: 'Bloqueado / anulado / ya completado' } }
            }
        },
        '/api/resultado': {
            get: {
                tags: ['Quiz'], summary: 'Resultado de la evaluación (sesión o BD)',
                responses: { 200: { description: 'Puntaje, aprobado, detalle con feedback por pregunta' }, 404: { description: 'Sin resultado' } }
            }
        },
        '/api/trampa': {
            post: {
                tags: ['Quiz'], summary: 'Reportar cambio de pestaña/ventana (automático)',
                description: 'Al 3.° bloqueo la evaluación se **anula** automáticamente.',
                requestBody: { content: { 'application/json': { schema: { type:'object',
                    properties: { motivo: { type:'string', example:'CAMBIO_PESTAÑA' } }
                }}}},
                responses: { 200: { description: '{ estado: "bloqueado"|"anulado"|"ya_bloqueado" }' } }
            }
        },
        '/api/desbloquear': {
            post: {
                tags: ['Quiz'], summary: 'Desbloquear con código del profesor',
                requestBody: { required: true, content: { 'application/json': { schema: { type:'object',
                    properties: { codigo: { type:'string', example:'4F2A9C' } }
                }}}},
                responses: { 200: { description: '{ ok: true } | { ok: false, mensaje }' } }
            }
        },
        '/api/admin/bloqueos/stream': {
            get: {
                tags: ['Admin'],
                summary: 'SSE – stream en tiempo real de bloqueos',
                description:
                    'Mantén esta conexión abierta. Recibirás un evento `init` con los bloqueos activos pendientes y un evento `bloqueo_nuevo` cada vez que un estudiante sea bloqueado.\n\n' +
                    '**Uso con curl:**\n```\ncurl -N -b "connect.sid=TU_COOKIE" http://localhost:3000/api/admin/bloqueos/stream\n```\n\n' +
                    'Cada evento `bloqueo_nuevo` contiene: `nombre`, `documento`, `motivo`, `fecha`, `codigo`, `total_bloqueos`.',
                responses: {
                    200: { description: 'text/event-stream — eventos: init | bloqueo_nuevo | heartbeat',
                        content: { 'text/event-stream': { schema: { type: 'string',
                            example: 'event: bloqueo_nuevo\ndata: {"nombre":"ORTIZ GOMEZ JUAN PABLO","codigo":"4F2A9C","total_bloqueos":1}\n\n'
                        }}}
                    }
                }
            }
        },
        '/api/admin/bloqueos': {
            get: {
                tags: ['Admin'], summary: 'Historial completo de bloqueos con códigos',
                responses: { 200: { description: 'Array con nombre, motivo, fecha, codigo, desbloqueado, total_bloqueos' } }
            }
        },
        '/api/admin/estudiantes': {
            get: {
                tags: ['Admin'], summary: 'Lista de estudiantes con estado completo',
                responses: { 200: { description: 'id, nombre, documento, bloqueado, anulado, completado, puntaje, aprobado, fecha_resultado, total_bloqueos' } }
            }
        },
        '/api/admin/resultados': {
            get: {
                tags: ['Admin'], summary: 'Resultados de todos los estudiantes',
                responses: { 200: { description: 'nombre, documento, puntaje, total, aprobado, fecha' } }
            }
        },
        '/api/admin/advertencias': {
            get: {
                tags: ['Admin'], summary: 'Cierres de ventana registrados durante evaluaciones',
                description: 'Cada vez que un estudiante cierra la ventana mientras tiene el quiz activo queda registrado aquí. No bloquea al estudiante.',
                responses: { 200: { description: 'nombre, documento, tipo, fecha — ordenado por fecha desc' } }
            }
        },
        '/api/admin/desbloquear/{id}': {
            post: {
                tags: ['Admin'], summary: 'Desbloquear estudiante manualmente',
                parameters: [{ name:'id', in:'path', required:true, schema:{ type:'integer' }, example: 6 }],
                responses: { 200: { description: '{ ok: true }' } }
            }
        },
        '/api/admin/anular/{id}': {
            post: {
                tags: ['Admin'], summary: 'Anular evaluación de un estudiante',
                parameters: [{ name:'id', in:'path', required:true, schema:{ type:'integer' }, example: 6 }],
                responses: { 200: { description: '{ ok: true }' } }
            }
        },
        '/api/admin/reactivar/{id}': {
            post: {
                tags: ['Admin'], summary: 'Reactivar — borra bloqueos, anulación y resultado',
                description: '⚠️ Permite al estudiante volver a presentar desde cero.',
                parameters: [{ name:'id', in:'path', required:true, schema:{ type:'integer' }, example: 6 }],
                responses: { 200: { description: '{ ok: true }' } }
            }
        },
        '/api/admin/logout': {
            post: {
                tags: ['Admin'], summary: 'Cerrar sesión de admin',
                responses: { 200: { description: '{ ok: true }' } }
            }
        },
    }
};

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Infokey API',
    customCss: '.swagger-ui .topbar { background: #2c3e50; }',
}));

// ── Middleware ───────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 4 },
}));
app.use(express.static(path.join(__dirname, 'public')));

const requireAuth  = (req, res, next) => req.session?.usuario  ? next() : res.redirect('/');
const requireAdmin = (req, res, next) => req.session?.esAdmin  ? next() : res.status(401).json({ error: 'No autorizado.' });

// ── Auth ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    if (req.session?.usuario) return res.redirect('/cuestionario');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/ingresar', (req, res) => {
    const { nombre, documento } = req.body;
    if (!nombre?.trim() || !documento?.trim()) return res.redirect('/?error=vacio');

    const nombreNorm = normalizar(nombre);
    const docNorm    = documento.trim();

    const est = db.prepare('SELECT * FROM estudiantes WHERE nombre = ?').get(nombreNorm);
    if (!est) return res.redirect('/?error=noregistrado');

    // Validar cédula si está registrada en data/estudiantes.json
    if (est.documento && est.documento !== docNorm)
        return res.redirect('/?error=cedula');

    db.prepare("UPDATE estudiantes SET ultimo_acceso = datetime('now','localtime') WHERE id = ?").run(est.id);

    req.session.usuario = { id: est.id, nombre: est.nombre, documento: docNorm, completado: est.completado === 1 };

    if (est.completado) return res.redirect('/resultados');
    res.redirect('/cuestionario');
});

app.get('/salir', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ── Páginas protegidas ───────────────────────────────────────────────
app.get('/cuestionario', requireAuth, (req, res) => {
    const est = db.prepare('SELECT completado FROM estudiantes WHERE id = ?').get(req.session.usuario.id);
    if (est?.completado) return res.redirect('/resultados');
    res.sendFile(path.join(__dirname, 'public', 'cuestionario.html'));
});

app.get('/resultados', requireAuth, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'resultados.html')));

// ── API Quiz ─────────────────────────────────────────────────────────
app.get('/api/yo', requireAuth, (req, res) => res.json(req.session.usuario));

app.get('/api/preguntas', requireAuth, (req, res) => {
    const est = db.prepare('SELECT completado FROM estudiantes WHERE id = ?').get(req.session.usuario.id);
    if (est?.completado) return res.status(403).json({ error: 'Evaluación ya completada.' });
    res.json(PREGUNTAS);
});

// Progreso guardado (para restaurar tras cierre accidental)
app.get('/api/progreso', requireAuth, (req, res) => {
    const uid = req.session.usuario.id;
    const rows = db.prepare('SELECT pregunta_id, letra FROM progreso WHERE estudiante_id = ?').all(uid);
    const respuestas = {};
    rows.forEach(r => { respuestas[r.pregunta_id] = r.letra; });

    const sesion = db.prepare('SELECT segundos_restantes, iniciado FROM sesion_activa WHERE estudiante_id = ?').get(uid);

    res.json({
        respuestas,
        segundos_restantes: sesion?.segundos_restantes ?? DURACION,
        iniciado:           sesion?.iniciado === 1,
    });
});

// Marcar inicio del quiz
app.post('/api/iniciar', requireAuth, (req, res) => {
    const uid = req.session.usuario.id;
    db.prepare(`
        INSERT INTO sesion_activa (estudiante_id, segundos_restantes, iniciado)
        VALUES (?, ?, 1)
        ON CONFLICT(estudiante_id) DO UPDATE SET iniciado = 1
    `).run(uid, DURACION);
    res.json({ ok: true });
});

// Guardar una respuesta + tiempo restante
app.post('/api/guardar', requireAuth, (req, res) => {
    const uid = req.session.usuario.id;
    const { pregunta_id, letra, segundos_restantes } = req.body;
    if (!pregunta_id || !letra) return res.status(400).json({ error: 'Faltan datos.' });

    db.prepare(`
        INSERT INTO progreso (estudiante_id, pregunta_id, letra)
        VALUES (?, ?, ?)
        ON CONFLICT(estudiante_id, pregunta_id) DO UPDATE SET letra = excluded.letra, fecha = datetime('now','localtime')
    `).run(uid, pregunta_id, letra.toUpperCase());

    if (segundos_restantes != null) {
        db.prepare(`
            INSERT INTO sesion_activa (estudiante_id, segundos_restantes, iniciado)
            VALUES (?, ?, 1)
            ON CONFLICT(estudiante_id) DO UPDATE SET segundos_restantes = excluded.segundos_restantes
        `).run(uid, segundos_restantes);
    }
    res.json({ ok: true });
});

// Estado del estudiante
app.get('/api/estado', requireAuth, (req, res) => {
    const uid = req.session.usuario.id;
    const est = db.prepare('SELECT bloqueado, anulado, completado FROM estudiantes WHERE id = ?').get(uid);

    if (est.anulado)    return res.json({ estado: 'anulado' });
    if (est.completado) return res.json({ estado: 'completado' });
    if (est.bloqueado) {
        const bloqueo = db.prepare(
            'SELECT id, fecha, codigo FROM bloqueos WHERE estudiante_id = ? AND desbloqueado = 0 ORDER BY fecha DESC LIMIT 1'
        ).get(uid);
        const total = db.prepare('SELECT COUNT(*) as n FROM bloqueos WHERE estudiante_id = ?').get(uid).n;
        return res.json({ estado: 'bloqueado', bloqueo, total });
    }
    res.json({ estado: 'ok' });
});

// Advertencia de cierre de ventana (sendBeacon — no bloquea)
app.post('/api/advertencia', requireAuth, (req, res) => {
    const uid  = req.session.usuario.id;
    const tipo = req.body.tipo || 'CIERRE_VENTANA';
    db.prepare('INSERT INTO advertencias (estudiante_id, tipo) VALUES (?, ?)').run(uid, tipo);
    res.json({ ok: true });
});

// Reportar trampa + notificar SSE
app.post('/api/trampa', requireAuth, (req, res) => {
    const uid  = req.session.usuario.id;
    const est  = db.prepare('SELECT bloqueado, anulado, completado FROM estudiantes WHERE id = ?').get(uid);
    if (est.anulado || est.bloqueado || est.completado)
        return res.json({ estado: 'ya_bloqueado' });

    const codigo = genCodigo();
    db.prepare('INSERT INTO bloqueos (estudiante_id, documento, motivo, codigo) VALUES (?,?,?,?)')
      .run(uid, req.session.usuario.documento, req.body.motivo || 'CAMBIO_PESTAÑA', codigo);

    const totalBloqueos = db.prepare('SELECT COUNT(*) as n FROM bloqueos WHERE estudiante_id = ?').get(uid).n;

    if (totalBloqueos >= MAX_TRAMPAS) {
        db.prepare('UPDATE estudiantes SET anulado = 1, bloqueado = 0 WHERE id = ?').run(uid);
        sseEnviar('bloqueo_nuevo', {
            nombre: req.session.usuario.nombre, documento: req.session.usuario.documento,
            motivo: req.body.motivo, fecha: new Date().toLocaleString('es-CO'),
            codigo, total_bloqueos: totalBloqueos, anulado: true,
        });
        return res.json({ estado: 'anulado' });
    }

    db.prepare('UPDATE estudiantes SET bloqueado = 1 WHERE id = ?').run(uid);

    // Notificar al profesor en tiempo real
    sseEnviar('bloqueo_nuevo', {
        estudiante_id: uid,
        nombre:        req.session.usuario.nombre,
        documento:     req.session.usuario.documento,
        motivo:        req.body.motivo || 'CAMBIO_PESTAÑA',
        fecha:         new Date().toLocaleString('es-CO'),
        codigo,
        total_bloqueos: totalBloqueos,
        anulado: false,
    });

    res.json({ estado: 'bloqueado', codigo, totalBloqueos });
});

// Desbloquear con código
app.post('/api/desbloquear', requireAuth, (req, res) => {
    const uid     = req.session.usuario.id;
    const codigo  = (req.body.codigo || '').toUpperCase().trim();
    const bloqueo = db.prepare(
        'SELECT id FROM bloqueos WHERE estudiante_id = ? AND codigo = ? AND desbloqueado = 0'
    ).get(uid, codigo);

    if (!bloqueo) return res.json({ ok: false, mensaje: 'Código incorrecto.' });
    db.prepare('UPDATE bloqueos SET desbloqueado = 1 WHERE id = ?').run(bloqueo.id);
    db.prepare('UPDATE estudiantes SET bloqueado = 0 WHERE id = ?').run(uid);
    res.json({ ok: true });
});

// Validar respuestas (una sola vez)
app.post('/api/validar', requireAuth, (req, res) => {
    const uid = req.session.usuario.id;
    const est = db.prepare('SELECT bloqueado, anulado, completado FROM estudiantes WHERE id = ?').get(uid);

    if (est.anulado)    return res.status(403).json({ error: 'Evaluación anulada.' });
    if (est.bloqueado)  return res.status(403).json({ error: 'Cuenta bloqueada.' });
    if (est.completado) return res.status(403).json({ error: 'La evaluación ya fue realizada.' });

    const { respuestas } = req.body;
    if (!respuestas || typeof respuestas !== 'object')
        return res.status(400).json({ error: 'Respuestas inválidas.' });

    const detalle = PREGUNTAS.map(p => {
        const enviada  = (respuestas[String(p.id)] || '').toUpperCase();
        const correcta = CORRECTAS[String(p.id)];
        return { pregunta: p.id, texto: p.texto, enviada, correcta, aprobada: enviada === correcta, feedback: p.feedback };
    });

    const puntaje  = detalle.filter(d => d.aprobada).length;
    const aprobado = puntaje >= MINIMO;

    db.prepare(`
        INSERT INTO resultados (estudiante_id, documento, puntaje, total, aprobado, respuestas_json)
        VALUES (?,?,?,?,?,?)
    `).run(uid, req.session.usuario.documento, puntaje, TOTAL, aprobado ? 1 : 0, JSON.stringify(detalle));

    db.prepare('UPDATE estudiantes SET completado = 1, bloqueado = 0 WHERE id = ?').run(uid);
    // Limpiar progreso guardado
    db.prepare('DELETE FROM progreso       WHERE estudiante_id = ?').run(uid);
    db.prepare('DELETE FROM sesion_activa  WHERE estudiante_id = ?').run(uid);

    req.session.usuario.completado = true;
    req.session.resultado = { puntaje, total: TOTAL, aprobado, detalle, minimo: MINIMO };
    res.json({ ok: true });
});

// Resultado
app.get('/api/resultado', requireAuth, (req, res) => {
    if (req.session.resultado)
        return res.json({ usuario: req.session.usuario, ...req.session.resultado });

    const row = db.prepare('SELECT * FROM resultados WHERE estudiante_id = ?').get(req.session.usuario.id);
    if (!row) return res.status(404).json({ error: 'Sin resultado registrado.' });

    res.json({
        usuario:  req.session.usuario,
        puntaje:  row.puntaje,
        total:    row.total,
        aprobado: row.aprobado === 1,
        detalle:  JSON.parse(row.respuestas_json),
        minimo:   MINIMO,
    });
});

// ── API Admin ────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'infokey2026';

app.get('/admin', (req, res) => {
    if (req.session?.esAdmin) return res.redirect('/api/docs');
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/api/admin/login', express.urlencoded({ extended: false }), (req, res) => {
    const { email, password } = req.body;
    if (email === ADMIN_USER && password === ADMIN_PASS) {
        req.session.esAdmin = true;
        return res.redirect('/api/docs');
    }
    res.redirect('/admin?error=1');
});

app.post('/api/admin/logout', (req, res) => {
    req.session.esAdmin = false;
    res.redirect('/admin');
});

// SSE – stream de bloqueos en tiempo real
app.get('/api/admin/bloqueos/stream', requireAdmin, (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));

    // Enviar bloqueos activos al conectar
    const pendientes = db.prepare(`
        SELECT b.id, e.nombre, b.documento, b.motivo, b.fecha, b.codigo, b.desbloqueado,
               (SELECT COUNT(*) FROM bloqueos b2 WHERE b2.estudiante_id = e.id) AS total_bloqueos,
               e.anulado, e.id AS estudiante_id
        FROM bloqueos b JOIN estudiantes e ON e.id = b.estudiante_id
        WHERE b.desbloqueado = 0
        ORDER BY b.fecha DESC
    `).all();
    res.write(`event: init\ndata: ${JSON.stringify(pendientes)}\n\n`);

    const hb = setInterval(() => { try { res.write('event: heartbeat\ndata: {}\n\n'); } catch {} }, 25000);
    req.on('close', () => clearInterval(hb));
});

app.get('/api/admin/bloqueos', requireAdmin, (req, res) => {
    res.json(db.prepare(`
        SELECT b.id, e.nombre, b.documento, b.motivo, b.fecha, b.codigo, b.desbloqueado,
               (SELECT COUNT(*) FROM bloqueos b2 WHERE b2.estudiante_id = e.id) AS total_bloqueos,
               e.anulado, e.id AS estudiante_id
        FROM bloqueos b JOIN estudiantes e ON e.id = b.estudiante_id
        ORDER BY b.fecha DESC
    `).all());
});

app.get('/api/admin/estudiantes', requireAdmin, (req, res) => {
    res.json(db.prepare(`
        SELECT e.id, e.nombre, e.documento, e.ultimo_acceso, e.bloqueado, e.anulado, e.completado,
               (SELECT COUNT(*) FROM bloqueos b WHERE b.estudiante_id = e.id) AS total_bloqueos,
               r.puntaje, r.total, r.aprobado, r.fecha AS fecha_resultado
        FROM estudiantes e LEFT JOIN resultados r ON r.estudiante_id = e.id
        ORDER BY e.id
    `).all());
});

app.get('/api/admin/resultados', requireAdmin, (req, res) => {
    res.json(db.prepare(`
        SELECT r.id, e.nombre, r.documento, r.puntaje, r.total, r.aprobado, r.fecha,
               e.bloqueado, e.anulado,
               (SELECT COUNT(*) FROM bloqueos b WHERE b.estudiante_id = e.id) AS total_bloqueos
        FROM resultados r JOIN estudiantes e ON e.id = r.estudiante_id
        ORDER BY r.fecha DESC
    `).all());
});

app.get('/api/admin/advertencias', requireAdmin, (req, res) => {
    res.json(db.prepare(`
        SELECT a.id, e.nombre, e.documento, a.tipo, a.fecha
        FROM advertencias a JOIN estudiantes e ON e.id = a.estudiante_id
        ORDER BY a.fecha DESC
    `).all());
});

app.post('/api/admin/desbloquear/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    db.prepare('UPDATE estudiantes SET bloqueado = 0 WHERE id = ?').run(id);
    db.prepare('UPDATE bloqueos SET desbloqueado = 1 WHERE estudiante_id = ? AND desbloqueado = 0').run(id);
    res.json({ ok: true });
});

app.post('/api/admin/anular/:id', requireAdmin, (req, res) => {
    db.prepare('UPDATE estudiantes SET anulado = 1, bloqueado = 0 WHERE id = ?').run(parseInt(req.params.id));
    res.json({ ok: true });
});

app.post('/api/admin/reactivar/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    db.prepare('UPDATE estudiantes SET anulado = 0, bloqueado = 0, completado = 0 WHERE id = ?').run(id);
    db.prepare('DELETE FROM resultados      WHERE estudiante_id = ?').run(id);
    db.prepare('DELETE FROM bloqueos        WHERE estudiante_id = ?').run(id);
    db.prepare('DELETE FROM progreso        WHERE estudiante_id = ?').run(id);
    db.prepare('DELETE FROM sesion_activa   WHERE estudiante_id = ?').run(id);
    res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
