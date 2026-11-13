const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { Pool } = require('pg');

const ROOT = __dirname;

const products = [
  '0,2 L', '0,33 L', '0,33 L EXCLUSIVE', '0,5 L',
  '1 L', '1 L EXCLUSIVE', '1,5 L', '5 L',
  '180 CC', '250 CC', '0,33 L CAM', '0,75 L CAM',
  '19 L PET', '19 L PC', '15 L CAM'
];

const warehouses = [
  'FABRİKA', 'SAKARYA', 'AVRUPA', 'ANADOLU', 'ANKARA'
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const defaultRows = () =>
  products.flatMap(product =>
    warehouses.map(warehouse => ({
      product,
      warehouse,
      onHand: 0,
      inTransit: 0,
      minStock: 0,
      updatedAt: null
    }))
  );

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_state (
      id INTEGER PRIMARY KEY,
      rows JSONB NOT NULL
    )
  `);

  await pool.query(
    `INSERT INTO stock_state (id, rows)
     VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(defaultRows())]
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_notifications (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      changed_products INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    )
  `);

  console.log('PostgreSQL stok veritabanı hazır.');
}

async function getRows() {
  const result = await pool.query(
    'SELECT rows FROM stock_state WHERE id = 1'
  );
  return result.rows[0].rows;
}

function auth(req, res) {
  const username = process.env.APP_USER || 'admin';
  const password = process.env.APP_PASSWORD || 'Buzdagi2026!';

  const expected = 'Basic ' +
    Buffer.from(username + ':' + password).toString('base64');

  if (req.headers.authorization !== expected) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Buzdagi Stok"'
    });
    res.end('Giris gerekli');
    return false;
  }
  return true;
}

function json(res, obj, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1000000) {
        reject(new Error('Veri boyutu çok büyük'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function summary(rows) {
  const totals = warehouses.map(name => {
    const rs = rows.filter(x => x.warehouse === name);

    const onHand = rs.reduce((a, x) => a + x.onHand, 0);
    const inTransit = rs.reduce((a, x) => a + x.inTransit, 0);

    return {
      name,
      onHand,
      inTransit,
      value: onHand + inTransit
    };
  });

  const pm = {};

  rows.forEach(x => {
    pm[x.product] =
      (pm[x.product] || 0) + x.onHand + x.inTransit;
  });

  return {
    grand: totals.reduce((a, x) => a + x.value, 0),
    road: totals.reduce((a, x) => a + x.inTransit, 0),
    critical: rows.filter(
      x => x.minStock > 0 &&
      x.onHand + x.inTransit < x.minStock
    ).length,
    totals,
    productTotals: Object.entries(pm)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value),
    updatedAt:
      rows.map(x => x.updatedAt)
        .filter(Boolean)
        .sort()
        .at(-1) || null
  };
}

const server = http.createServer(async (req, res) => {
  if (!auth(req, res)) return;

  const p = url.parse(req.url, true).pathname;

  try {
    if (p === '/api/state' && req.method === 'GET') {
      const rows = await getRows();

      return json(res, {
        rows,
        history: [],
        summary: summary(rows)
      });
    }

    if (p === '/api/notifications' && req.method === 'GET') {
      const result = await pool.query(`
        SELECT id::text, title, message, changed_products AS "changedProducts",
               created_at AS "createdAt", read_at AS "readAt"
        FROM stock_notifications ORDER BY id DESC LIMIT 50
      `);
      const unread = await pool.query('SELECT COUNT(*)::int AS count FROM stock_notifications WHERE read_at IS NULL');
      return json(res, { notifications: result.rows, unread: unread.rows[0].count });
    }

    if (p === '/api/notifications/read' && req.method === 'POST') {
      await pool.query('UPDATE stock_notifications SET read_at = NOW() WHERE read_at IS NULL');
      return json(res, { ok: true });
    }

    if (p === '/api/save' && req.method === 'POST') {
      const b = await body(req);

      if (!Array.isArray(b.items)) {
        return json(res, { error: 'Geçersiz veri' }, 400);
      }

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const result = await client.query(
          'SELECT rows FROM stock_state WHERE id = 1 FOR UPDATE'
        );

        const old = result.rows[0].rows;
        const now = new Date().toISOString();

        const map = new Map(
          old.map(x => [x.product + '|' + x.warehouse, x])
        );

        const factoryChanges = new Set();

        for (const i of b.items) {
          const key = i.product + '|' + i.warehouse;

          if (!map.has(key)) continue;

          const prev = map.get(key);

          const nextOnHand = Math.max(0, Math.round(Number(i.onHand) || 0));
          const nextInTransit = Math.max(0, Math.round(Number(i.inTransit) || 0));
          if (i.warehouse === 'FABRİKA' &&
              (Number(prev.onHand) !== nextOnHand || Number(prev.inTransit) !== nextInTransit)) {
            factoryChanges.add(i.product);
          }

          map.set(key, {
            ...prev,
            onHand: nextOnHand,
            inTransit: nextInTransit,
            minStock: Math.max(
              0, Math.round(Number(i.minStock) || 0)
            ),
            updatedAt: now
          });
        }

        const rows = [...map.values()];

        await client.query(
          'UPDATE stock_state SET rows = $1::jsonb WHERE id = 1',
          [JSON.stringify(rows)]
        );

        if (factoryChanges.size > 0) {
          await client.query(`
            INSERT INTO stock_notifications (title, message, changed_products)
            VALUES ($1, $2, $3)
          `, [
            'Fabrika Stokları Güncellendi',
            `Fabrika stok bilgileri güncellendi. ${factoryChanges.size} ürünün stok miktarı değişti. Güncel verileri Fabrika Dashboard üzerinden görüntüleyebilirsiniz.`,
            factoryChanges.size
          ]);
        }

        await client.query('COMMIT');

        return json(res, {
          ok: true,
          summary: summary(rows)
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    if (p === '/api/backup' && req.method === 'GET') {
      const rows = await getRows();

      const lines = [
        'Ürün;Depo;Depo Stok;Yolda;Toplam;Minimum Stok;Son Güncelleme',
        ...rows.map(x => [
          x.product,
          x.warehouse,
          x.onHand,
          x.inTransit,
          x.onHand + x.inTransit,
          x.minStock,
          x.updatedAt || ''
        ].join(';'))
      ];

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition':
          'attachment; filename="buzdagi-stok-yedek.csv"'
      });

      return res.end('\ufeff' + lines.join('\r\n'));
    }

    const file = p === '/' ? 'index.html' : p.slice(1);
    const publicRoot = path.join(ROOT, 'public');
    const fp = path.resolve(publicRoot, file);

    if (
      !fp.startsWith(publicRoot + path.sep) &&
      fp !== path.join(publicRoot, 'index.html')
    ) {
      res.writeHead(404);
      return res.end('Bulunamadi');
    }

    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      res.writeHead(404);
      return res.end('Bulunamadi');
    }

    const ext = path.extname(fp);

    const ct =
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.js' ? 'text/javascript; charset=utf-8' :
      'text/html; charset=utf-8';

    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': 'no-store'
    });

    fs.createReadStream(fp).pipe(res);
  } catch (error) {
    console.error(error);
    json(res, { error: 'Sunucu işlemi başarısız' }, 500);
  }
});

async function start() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL tanımlanmamış.');
  }

  await initializeDatabase();

  const port = Number(process.env.PORT) || 3100;

  server.listen(port, '0.0.0.0', () => {
    console.log('BUZDAGI STOK HAZIR: Port ' + port);
  });
}

start().catch(error => {
  console.error('Başlatma hatası:', error);
  process.exit(1);
});
