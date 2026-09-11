const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();

const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || '';

const JWT_SECRET =
  process.env.JWT_SECRET || '';

const PLATFORM_ADMIN_PASSWORD =
  process.env.PLATFORM_ADMIN_PASSWORD || '';

if (!PLATFORM_ADMIN_PASSWORD) {
  console.warn(
    '⚠️ PLATFORM_ADMIN_PASSWORD is not set.'
  );
}

if (!process.env.DATABASE_URL) {
  console.warn(
    '⚠️ DATABASE_URL is not set.'
  );
}

if (!ADMIN_PASSWORD) {
  console.warn(
    '⚠️ ADMIN_PASSWORD is not set.'
  );
}

if (!JWT_SECRET) {
  console.warn(
    '⚠️ JWT_SECRET is not set.'
  );
}

// ============================================================
// DATABASE
// ============================================================

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString:
        process.env.DATABASE_URL,

      ssl:
        process.env.DATABASE_URL.includes('localhost') ||
        process.env.DATABASE_URL.includes('127.0.0.1')
          ? false
          : {
              rejectUnauthorized: false
            }
    })
  : null;

async function dbQuery(
  text,
  params = []
) {
  if (!pool) {
    throw new Error(
      'DATABASE_URL is not configured'
    );
  }

  return pool.query(
    text,
    params
  );
}

// ============================================================
// DATABASE CONNECTION TEST
// ============================================================

async function testDatabaseConnection() {
  if (!pool) {
    console.warn(
      '⚠️ Database connection skipped because DATABASE_URL is missing.'
    );

    return false;
  }

  try {
    const result =
      await dbQuery(
        'SELECT NOW() AS now'
      );

    console.log(
      '✅ PostgreSQL connection successful'
    );

    console.log(
      '🕒 Database time:',
      result.rows[0].now
    );

    return true;
  } catch (error) {
    console.error(
      '❌ PostgreSQL connection failed:'
    );

    console.error(
      error.message
    );

    return false;
  }
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: '15mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '15mb'
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  '/health',
  async (_req, res) => {
    try {
      if (!pool) {
        return res.status(500).json({
          success: false,
          database: false,
          error:
            'DATABASE_URL is not configured'
        });
      }

      await dbQuery(
        'SELECT 1'
      );

      res.json({
        success: true,
        database: true
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        database: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// DATABASE INSPECTION
// READ ONLY
// ============================================================

app.get(
  '/debug/database',
  async (_req, res) => {
    try {
      if (!pool) {
        return res.status(500).json({
          success: false,
          error:
            'DATABASE_URL is not configured'
        });
      }

      const result =
        await dbQuery(`
          SELECT
            current_database() AS database_name,
            current_user AS database_user,
            NOW() AS server_time
        `);

      res.json({
        success: true,
        database:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// READ-ONLY DATA CHECK
// ============================================================

app.get(
  '/debug/data',
  async (_req, res) => {
    try {
      if (!pool) {
        return res.status(500).json({
          success: false,
          error:
            'DATABASE_URL is not configured'
        });
      }

      const tables =
        await dbQuery(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
          ORDER BY table_name
        `);

      const result = {};

      for (
        const row of tables.rows
      ) {
        const table =
          row.table_name;

        if (
          ![
            'brands',
            'products',
            'users',
            'orders',
            'tenants'
          ].includes(table)
        ) {
          continue;
        }

        const count =
          await dbQuery(
            `SELECT COUNT(*)::int AS count FROM "${table}"`
          );

        result[table] =
          count.rows[0].count;
      }

      res.json({
        success: true,
        tables: result
      });
    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// TENANT HELPERS
// ============================================================

async function getTenantById(
  tenantId
) {
  const {
    rows
  } = await dbQuery(
    `
      SELECT *
      FROM tenants
      WHERE id = $1
      LIMIT 1
    `,
    [tenantId]
  );

  return (
    rows[0] ||
    null
  );
}

async function getTenantByDomain(
  domain
) {
  const { rows } = await dbQuery(
    `
      SELECT *
      FROM tenants
      WHERE store_domain = $1
         OR admin_domain = $1
      LIMIT 1
    `,
    [domain]
  );

  return rows[0] || null;
}

// ============================================================
// TENANT RESOLUTION
// ============================================================

async function resolveTenant(
  req
) {
  const headerTenant =
    req.headers[
      'x-tenant-id'
    ];

  if (headerTenant) {
    const tenant =
      await getTenantById(
        headerTenant
      );

    if (tenant) {
      return tenant;
    }
  }

  const host =
    String(
      req.headers.host ||
      ''
    )
      .split(':')[0]
      .toLowerCase();

  const tenantByDomain =
    await getTenantByDomain(
      host
    );

  if (tenantByDomain) {
    return tenantByDomain;
  }

  // Compatibility with current Memento setup.
  return getTenantById(
    'memento'
  );
}

async function tenantMiddleware(
  req,
  res,
  next
) {
  try {
    const tenant =
      await resolveTenant(
        req
      );

    if (!tenant) {
      return res.status(404).json({
        error:
          'Tenant not found'
      });
    }

    req.tenant =
      tenant;

    req.tenantId =
      tenant.id;

    next();
  } catch (error) {
    console.error(
      'Tenant resolution error:',
      error
    );

    res.status(500).json({
      error:
        'Tenant resolution failed'
    });
  }
}

// ============================================================
// DELIVERY PRICES BY GOVERNORATE
// ============================================================

const DELIVERY_GOVERNORATES = {
  cairo: "القاهرة",
  giza: "الجيزة",
  alexandria: "الإسكندرية",
  qalyubia: "القليوبية",
  port_said: "بورسعيد",
  suez: "السويس",
  damietta: "دمياط",
  dakahlia: "الدقهلية",
  sharqia: "الشرقية",
  gharbia: "الغربية",
  kafr_elsheikh: "كفر الشيخ",
  beheira: "البحيرة",
  matrouh: "مطروح",
  monufia: "المنوفية",
  fayoum: "الفيوم",
  beni_suef: "بني سويف",
  minya: "المنيا",
  asyut: "أسيوط",
  sohag: "سوهاج",
  qena: "قنا",
  luxor: "الأقصر",
  aswan: "أسوان",
  red_sea: "البحر الأحمر",
  new_valley: "الوادي الجديد",
  north_sinai: "شمال سيناء",
  south_sinai: "جنوب سيناء",
  ismailia: "الإسماعيلية"
};

function normalizeDeliveryFees(fees, fallbackFee = 0) {
  const result = {};

  for (const key of Object.keys(DELIVERY_GOVERNORATES)) {
    const value = Number(fees?.[key]);

    result[key] =
      Number.isFinite(value) && value >= 0
        ? value
        : Number(fallbackFee) || 0;
  }

  return result;
}

function getDeliveryFeeForGovernorate(brand, governorate) {
  const fees = normalizeDeliveryFees(
    brand?.deliveryFees,
    brand?.deliveryFee || 0
  );

  return fees[governorate] ?? Number(brand?.deliveryFee) ?? 0;
}

// ============================================================
// BRAND
// ============================================================

async function getBrand(
  tenantId
) {
  const {
    rows
  } = await dbQuery(
    `
      SELECT data
      FROM brands
      WHERE tenant_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [tenantId]
  );

  return (
    rows[0]?.data ||
    null
  );
}

async function saveBrand(
  brand,
  tenantId
) {
  const existing =
    await dbQuery(
      `
        SELECT id
        FROM brands
        WHERE tenant_id = $1
        LIMIT 1
      `,
      [tenantId]
    );

  if (
    existing.rows[0]
  ) {
    await dbQuery(
      `
        UPDATE brands
        SET
          data = $1,
          updated_at = NOW()
        WHERE id = $2
      `,
      [
        brand,
        existing.rows[0].id
      ]
    );
  } else {
    await dbQuery(
      `
        INSERT INTO brands (
          id,
          data,
          tenant_id
        )
        VALUES (
          $1,
          $2,
          $3
        )
      `,
      [
        brand.id ||
          uuidv4(),
        brand,
        tenantId
      ]
    );
  }
}

// ============================================================
// PRODUCTS
// ============================================================

async function getProducts(
  tenantId
) {
  const {
    rows
  } = await dbQuery(
    `
      SELECT data
      FROM products
      WHERE tenant_id = $1
      ORDER BY created_at ASC
    `,
    [tenantId]
  );

  return rows.map(
    row => row.data
  );
}

// ============================================================
// ORDERS
// ============================================================

async function getOrders(
  tenantId
) {
  const {
    rows
  } = await dbQuery(
    `
      SELECT data
      FROM orders
      WHERE tenant_id = $1
      ORDER BY created_at ASC
    `,
    [tenantId]
  );

  return rows.map(
    row => row.data
  );
}

// ============================================================
// USERS
// ============================================================

async function getUsers(
  tenantId
) {
  const {
    rows
  } = await dbQuery(
    `
      SELECT data
      FROM users
      WHERE tenant_id = $1
      ORDER BY created_at ASC
    `,
    [tenantId]
  );

  return rows.map(
    row => row.data
  );
}

// ============================================================
// PLATFORM ADMIN AUTH
// ============================================================

function requirePlatformAdmin(
  req,
  res,
  next
) {
  const password =
    req.headers[
      'x-platform-password'
    ] || '';

  if (!PLATFORM_ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      error:
        'PLATFORM_ADMIN_PASSWORD is not configured'
    });
  }

  if (
    password !==
    PLATFORM_ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      success: false,
      error:
        'Platform admin password is incorrect'
    });
  }

  next();
}

// ============================================================
// ADMIN AUTH
// ============================================================

const adminSessions =
  new Map();


function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Authentication required"
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded.userId || !decoded.tenantId) {
      return res.status(401).json({
        success: false,
        error: "Invalid authentication token"
      });
    }

    if (decoded.tenantId !== req.tenantId) {
      return res.status(403).json({
        success: false,
        error: "Invalid tenant"
      });
    }

    req.userId = decoded.userId;
    req.userEmail = decoded.email || "";

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired token"
    });
  }
}


function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Authentication required"
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded.userId || !decoded.tenantId) {
      return res.status(401).json({
        success: false,
        error: "Invalid authentication token"
      });
    }

    if (decoded.tenantId !== req.tenantId) {
      return res.status(403).json({
        success: false,
        error: "Invalid tenant"
      });
    }

    req.userId = decoded.userId;
    req.userEmail = decoded.email || "";

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired token"
    });
  }
}

function requireAdmin(
  req,
  res,
  next
) {
  const auth =
    req.headers.authorization ||
    '';

  const token =
    auth.startsWith(
      'Bearer '
    )
      ? auth.slice(7)
      : '';

  const session =
    adminSessions.get(
      token
    );

  if (
    !session ||
    session.expiresAt <
      Date.now()
  ) {
    if (token) {
      adminSessions.delete(
        token
      );
    }

    return res.status(401).json({
      error:
        'Unauthorized'
    });
  }

  if (
    session.tenantId &&
    req.tenantId &&
    session.tenantId !==
      req.tenantId
  ) {
    return res.status(403).json({
      error:
        'Wrong tenant'
    });
  }

  next();
}

// ============================================================
// USER JWT
// ============================================================

function generateToken(
  userId,
  tenantId
) {
  return jwt.sign(
    {
      userId,
      tenantId
    },
    JWT_SECRET,
    {
      expiresIn: '7d'
    }
  );
}

function authenticateUser(
  req,
  res,
  next
) {
  const auth =
    req.headers.authorization ||
    '';

  const token =
    auth.startsWith(
      'Bearer '
    )
      ? auth.slice(7)
      : '';

  if (!token) {
    return res.status(401).json({
      error:
        'No token provided'
    });
  }

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    req.userId =
      decoded.userId;

    req.userTenantId =
      decoded.tenantId ||
      'memento';

    if (
      req.tenantId &&
      req.userTenantId !==
        req.tenantId
    ) {
      return res.status(403).json({
        error:
          'Wrong tenant'
      });
    }

    next();
  } catch {
    return res.status(401).json({
      error:
        'Invalid token'
    });
  }
}
// ============================================================
// PLATFORM - TENANTS
// ============================================================

app.post(
  '/api/platform/tenants',
  requirePlatformAdmin,
  async (req, res) => {
    try {
      const {
        id,
        slug,
        name,
        storeDomain,
        adminDomain,
        adminPassword
      } = req.body || {};

      const tenantId =
        String(
          id || slug || ''
        )
          .trim()
          .toLowerCase();

      const tenantSlug =
        String(
          slug || id || ''
        )
          .trim()
          .toLowerCase();

      const tenantName =
        String(
          name || ''
        ).trim();

      const storeDomainValue =
        String(
          storeDomain || ''
        ).trim().toLowerCase();

      const adminDomainValue =
        String(
          adminDomain || ''
        ).trim().toLowerCase();

      if (
        !tenantId ||
        !/^[a-z0-9][a-z0-9-_]{1,49}$/.test(
          tenantId
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Invalid tenant id'
        });
      }

      if (
        !tenantSlug ||
        !/^[a-z0-9][a-z0-9-_]{1,49}$/.test(
          tenantSlug
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Invalid tenant slug'
        });
      }

      if (
        tenantName.length < 2
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Tenant name is required'
        });
      }

      if (
        !adminPassword ||
        String(adminPassword).length < 8
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Admin password must be at least 8 characters'
        });
      }

      if (
        !storeDomainValue ||
        !adminDomainValue
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Store domain and admin domain are required'
        });
      }

      const existing =
        await dbQuery(
          `
            SELECT id
            FROM tenants
            WHERE id = $1
               OR slug = $2
               OR store_domain = $3
               OR admin_domain = $4
            LIMIT 1
          `,
          [
            tenantId,
            tenantSlug,
            storeDomainValue,
            adminDomainValue
          ]
        );

      if (
        existing.rows.length
      ) {
        return res.status(409).json({
          success: false,
          error:
            'Tenant already exists'
        });
      }

      const passwordHash =
        await bcrypt.hash(
          String(adminPassword),
          12
        );

      await dbQuery(
        `
          INSERT INTO tenants (
            id,
            slug,
            name,
            store_domain,
            admin_domain,
            admin_password_hash,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            NOW(),
            NOW()
          )
        `,
        [
          tenantId,
          tenantSlug,
          tenantName,
          storeDomainValue,
          adminDomainValue,
          passwordHash
        ]
      );

      return res.status(201).json({
        success: true,
        tenant: {
          id: tenantId,
          slug: tenantSlug,
          name: tenantName,
          storeDomain:
            storeDomainValue,
          adminDomain:
            adminDomainValue
        }
      });

    } catch (error) {
      console.error(
        'Create tenant error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to create tenant'
      });
    }
  }
);

// ============================================================
// PLATFORM - GET TENANTS
// ============================================================

app.get(
  '/api/platform/tenants',
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const {
        rows
      } = await dbQuery(
        `
          SELECT
            id,
            slug,
            name,
            store_domain,
            admin_domain,
            created_at,
            updated_at
          FROM tenants
          ORDER BY created_at ASC
        `
      );

      return res.json({
        success: true,
        tenants: rows
      });

    } catch (error) {
      console.error(
        'Get tenants error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to load tenants'
      });
    }
  }
);

// ============================================================
// PLATFORM - GET ONE TENANT
// ============================================================

app.get(
  '/api/platform/tenants/:id',
  requirePlatformAdmin,
  async (req, res) => {
    try {
      const tenantId =
        String(
          req.params.id || ''
        )
          .trim()
          .toLowerCase();

      const {
        rows
      } = await dbQuery(
        `
          SELECT
            id,
            slug,
            name,
            store_domain,
            admin_domain,
            created_at,
            updated_at
          FROM tenants
          WHERE id = $1
          LIMIT 1
        `,
        [tenantId]
      );

      if (
        rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          error:
            'Tenant not found'
        });
      }

      return res.json({
        success: true,
        tenant:
          rows[0]
      });

    } catch (error) {
      console.error(
        'Get tenant error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to load tenant'
      });
    }
  }
);

// ============================================================
// ADMIN LOGIN
// ============================================================

app.post(
  '/api/admin/login',
  tenantMiddleware,
  async (req, res) => {
    try {
      const {
        password
      } = req.body || {};

      if (!password) {
        return res.status(401).json({
          error:
            'كلمة المرور غير صحيحة'
        });
      }

      const tenant =
        req.tenant;

      let validPassword =
        false;

      // Each tenant has its own
      // bcrypt admin password.
      if (
        tenant.admin_password_hash
      ) {
        validPassword =
          await bcrypt.compare(
            password,
            tenant.admin_password_hash
          );
      }

      // Compatibility with
      // existing Memento setup.
      else if (
        tenant.id === 'memento' &&
        ADMIN_PASSWORD
      ) {
        validPassword =
          password ===
          ADMIN_PASSWORD;

        if (validPassword) {
          const passwordHash =
            await bcrypt.hash(
              password,
              12
            );

          await dbQuery(
            `
              UPDATE tenants
              SET
                admin_password_hash = $1,
                updated_at = NOW()
              WHERE id = $2
            `,
            [
              passwordHash,
              tenant.id
            ]
          );

          req.tenant
            .admin_password_hash =
            passwordHash;
        }
      }

      if (!validPassword) {
        return res.status(401).json({
          error:
            'كلمة المرور غير صحيحة'
        });
      }

      const token =
        crypto
          .randomBytes(32)
          .toString('hex');

      adminSessions.set(
        token,
        {
          tenantId:
            req.tenantId,

          expiresAt:
            Date.now() +
            24 *
              60 *
              60 *
              1000
        }
      );

      return res.json({
        success: true,
        token
      });

    } catch (error) {
      console.error(
        'Admin login error:',
        error
      );

      return res.status(500).json({
        error:
          'Database error'
      });
    }
  }
);

// ============================================================
// ADMIN LOGOUT
// ============================================================

app.post(
  '/api/admin/logout',
  tenantMiddleware,
  requireAdmin,
  (req, res) => {
    const token =
      (
        req.headers.authorization ||
        ''
      ).slice(7);

    adminSessions.delete(
      token
    );

    res.json({
      success: true
    });
  }
);

// ============================================================
// IMAGE UPLOAD
// ============================================================

const upload =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      fileSize:
        2 * 1024 * 1024
    },

    fileFilter:
      (_req, file, cb) => {
        const allowed = [
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/gif'
        ];

        cb(
          null,
          allowed.includes(
            file.mimetype
          )
        );
      }
  });


app.post(
  '/api/admin/upload-multiple',
  tenantMiddleware,
  requireAdmin,
  upload.array('images', 10),
  (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'يرجى اختيار صورة واحدة على الأقل'
        });
      }

      const images = req.files.map(file =>
        `data:${file.mimetype};base64,${file.buffer.toString('base64')}`
      );

      return res.json({
        success: true,
        urls: images
      });
    } catch (error) {
      console.error('Multiple upload error:', error);

      return res.status(500).json({
        success: false,
        error: 'فشل رفع الصور'
      });
    }
  }
);

app.post(
  '/api/admin/upload',
  tenantMiddleware,
  requireAdmin,
  upload.single('image'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error:
          'يرجى اختيار صورة JPG أو PNG أو WEBP أو GIF'
      });
    }

    const image =
      `data:${req.file.mimetype};base64,` +
      req.file.buffer.toString(
        'base64'
      );

    res.json({
      success: true,
      url: image
    });
  }
);

// ============================================================
// ADMIN BRAND
// ============================================================

app.get(
  '/api/admin/brand',
  tenantMiddleware,
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      res.json(
        await getBrand(
          req.tenantId
        )
      );
    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        error:
          'Database error'
      });
    }
  }
);

app.post(
  '/api/admin/brand',
  tenantMiddleware,
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const deliveryFees = normalizeDeliveryFees(
        req.body.deliveryFees,
        req.body.deliveryFee || 0
      );

      const brand = {
        ...req.body,

        // أسعار التوصيل حسب المحافظة
        deliveryFee: deliveryFees.cairo,
        deliveryFees,

        id:
          req.body.id ||
          uuidv4()
      };

      await saveBrand(
        brand,
        req.tenantId
      );

      res.json({
        success: true,
        brand
      });

    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        error:
          'Database error'
      });
    }
  }
);

// ============================================================
// ADMIN PRODUCTS
// ============================================================

app.get(
  '/api/admin/products',
  tenantMiddleware,
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      res.json(
        await getProducts(
          req.tenantId
        )
      );
    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        error:
          'Database error'
      });
    }
  }
);

app.post(
  '/api/admin/products',
  tenantMiddleware,
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const product = {
        ...req.body,

        id:
          uuidv4(),

        createdAt:
          new Date()
            .toISOString(),

        price:
          Number(
            req.body.price
          ) || 0,

        quantity:
          Math.max(
            0,
            Number.parseInt(
              req.body.quantity,
              10
            ) || 0
          ),

        images:
          Array.isArray(
            req.body.images
          )
            ? req.body.images.filter(
                Boolean
              )
            : []
      };

      if (
        !product.name ||
        product.images.length === 0
      ) {
        return res.status(400).json({
          error:
            'اسم المنتج والصورة مطلوبان'
        });
      }

      await dbQuery(
        `
          INSERT INTO products (
            id,
            data,
            tenant_id
          )
          VALUES (
            $1,
            $2,
            $3
          )
        `,
        [
          product.id,
          product,
          req.tenantId
        ]
      );

      res.json({
        success: true,
        product
      });

    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        error:
          'Database error'
      });
    }
  }
);

// ============================================================
// ADMIN - DELETE PRODUCT
// ============================================================

app.delete(
  '/api/admin/products/:id',
  tenantMiddleware,
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const productId =
        String(
          req.params.id || ''
        ).trim();

      if (!productId) {
        return res.status(400).json({
          success: false,
          error:
            'Product ID is required'
        });
      }

      // مهم جداً:
      // الحذف يكون للمنتج التابع
      // لنفس الـ tenant فقط.
      const result =
        await dbQuery(
          `
            DELETE FROM products
            WHERE id = $1
              AND tenant_id = $2
          `,
          [
            productId,
            req.tenantId
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return res.status(404).json({
          success: false,
          error:
            'Product not found'
        });
      }

      return res.json({
        success: true,
        message:
          'Product deleted successfully',
        id:
          productId
      });

    } catch (error) {
      console.error(
        'Delete product error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Database error'
      });
    }
  }
);

// ============================================================
// ADMIN ORDERS
// ============================================================


// =========================
// V10 - Cancel order routes
// =========================

// Customer can cancel their own order while it is still new/pending/processing.
app.patch(
  '/api/store/orders/:id/cancel',
  tenantMiddleware,
  requireUser,
  async (req, res) => {
    try {
      const orderId = String(req.params.id || '').trim();

      if (!orderId) {
        return res.status(400).json({
          success: false,
          error: 'Order ID is required'
        });
      }

      const result = await dbQuery(
        `
          SELECT data
          FROM orders
          WHERE id = $1
            AND tenant_id = $2
          LIMIT 1
        `,
        [orderId, req.tenantId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      const order = result.rows[0].data || {};

      if (String(order.userId || '') !== String(req.userId || '')) {
        return res.status(403).json({
          success: false,
          error: 'You can only cancel your own orders'
        });
      }

      const currentStatus = String(order.status || 'new').toLowerCase();

      if (!['new', 'pending', 'processing'].includes(currentStatus)) {
        return res.status(400).json({
          success: false,
          error: 'This order cannot be cancelled now'
        });
      }

      const updatedOrder = {
        ...order,
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancelledBy: 'customer'
      };

      await dbQuery(
        `
          UPDATE orders
          SET data = $1::jsonb
          WHERE id = $2
            AND tenant_id = $3
        `,
        [JSON.stringify(updatedOrder), orderId, req.tenantId]
      );

      return res.json({
        success: true,
        order: updatedOrder
      });
    } catch (error) {
      console.error('Customer cancel order error:', error);

      return res.status(500).json({
        success: false,
        error: 'Database error'
      });
    }
  }
);

// Admin can cancel any order inside the current tenant.
app.patch(
  '/api/admin/orders/:id/cancel',
  tenantMiddleware,
  requireAdmin,
  async (req, res) => {
    try {
      const orderId = String(req.params.id || '').trim();

      if (!orderId) {
        return res.status(400).json({
          success: false,
          error: 'Order ID is required'
        });
      }

      const result = await dbQuery(
        `
          SELECT data
          FROM orders
          WHERE id = $1
            AND tenant_id = $2
          LIMIT 1
        `,
        [orderId, req.tenantId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      const order = result.rows[0].data || {};
      const currentStatus = String(order.status || 'new').toLowerCase();

      if (currentStatus === 'cancelled') {
        return res.status(400).json({
          success: false,
          error: 'Order is already cancelled'
        });
      }

      const updatedOrder = {
        ...order,
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancelledBy: 'admin'
      };

      await dbQuery(
        `
          UPDATE orders
          SET data = $1::jsonb
          WHERE id = $2
            AND tenant_id = $3
        `,
        [JSON.stringify(updatedOrder), orderId, req.tenantId]
      );

      return res.json({
        success: true,
        order: updatedOrder
      });
    } catch (error) {
      console.error('Admin cancel order error:', error);

      return res.status(500).json({
        success: false,
        error: 'Database error'
      });
    }
  }
);

app.get(
  '/api/admin/orders',
  tenantMiddleware,
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      res.json(
        await getOrders(
          req.tenantId
        )
      );
    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        error:
          'Database error'
      });
    }
  }
);

// ============================================================
// ADMIN USERS
// ============================================================

app.get(
  '/api/admin/users',
  tenantMiddleware,
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const users =
        await getUsers(
          req.tenantId
        );

      res.json(
        users.map(
          ({
            password,
            ...safe
          }) => safe
        )
      );

    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        error:
          'Database error'
      });
    }
  }
);

// ============================================================
// ADMIN STATS
// ============================================================

app.get(
  '/api/admin/stats',
  tenantMiddleware,
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const orders =
        await getOrders(
          req.tenantId
        );

      const users =
        await getUsers(
          req.tenantId
        );

      const totalRevenue =
        orders.reduce(
          (
            sum,
            order
          ) =>
            sum +
            (
              Number(
                order.totalPrice
              ) || 0
            ),
          0
        );

      res.json({
        totalRevenue,

        totalOrders:
          orders.length,

        totalUsers:
          users.length
      });

    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        error:
          'Database error'
      });
    }
  }
);
// ============================================================
// PART 3 — CUSTOMER AUTH + STORE APIs + ORDERS + START SERVER
// ============================================================

// ------------------------------------------------------------
// CUSTOMER REGISTER
// ------------------------------------------------------------

app.post('/api/auth/register', tenantMiddleware, async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phone,
      address
    } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Name, email and password are required'
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const existing = await dbQuery(
      `
      SELECT id
      FROM users
      WHERE tenant_id = $1
        AND LOWER(email) = LOWER($2)
      LIMIT 1
      `,
      [req.tenantId, normalizedEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Email already registered'
      });
    }

    const hashedPassword = await bcrypt.hash(String(password), 12);

    const user = {
      id: uuidv4(),
      name: String(name).trim(),
      email: normalizedEmail,
      phone: phone ? String(phone).trim() : '',
      address: address ? String(address).trim() : '',
      createdAt: new Date().toISOString()
    };

    await dbQuery(
      `
      INSERT INTO users (
        id,
        tenant_id,
        name,
        email,
        password_hash,
        data
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        user.id,
        req.tenantId,
        user.name,
        user.email,
        hashedPassword,
        JSON.stringify(user)
      ]
    );

    const token = jwt.sign(
      {
        userId: user.id,
        tenantId: req.tenantId,
        email: user.email
      },
      JWT_SECRET,
      {
        expiresIn: '30d'
      }
    );

    return res.status(201).json({
      success: true,
      token,
      user
    });

  } catch (error) {
    console.error('Register error:', error);

    return res.status(500).json({
      success: false,
      error: 'Registration failed'
    });
  }
});


// ------------------------------------------------------------
// CUSTOMER LOGIN
// ------------------------------------------------------------

app.post('/api/auth/login', tenantMiddleware, async (req, res) => {
  try {
    const {
      email,
      password
    } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const result = await dbQuery(
      `
      SELECT *
      FROM users
      WHERE tenant_id = $1
        AND LOWER(email) = LOWER($2)
      LIMIT 1
      `,
      [req.tenantId, normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    const row = result.rows[0];

    const validPassword = await bcrypt.compare(
      String(password),
      row.password_hash || ''
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    const userData =
      row.data && typeof row.data === 'object'
        ? row.data
        : {};

    const user = {
      ...userData,
      id: row.id,
      name: row.name || userData.name || '',
      email: row.email || userData.email || ''
    };

    const token = jwt.sign(
      {
        userId: row.id,
        tenantId: req.tenantId,
        email: row.email
      },
      JWT_SECRET,
      {
        expiresIn: '30d'
      }
    );

    return res.json({
      success: true,
      token,
      user
    });

  } catch (error) {
    console.error('Login error:', error);

    return res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});


// ------------------------------------------------------------
// CURRENT CUSTOMER
// ------------------------------------------------------------

app.get(
  '/api/auth/me',
  tenantMiddleware,
  requireUser,
  async (req, res) => {
    try {
      const result = await dbQuery(
        `
        SELECT *
        FROM users
        WHERE id = $1
          AND tenant_id = $2
        LIMIT 1
        `,
        [req.userId, req.tenantId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      const row = result.rows[0];

      const userData =
        row.data && typeof row.data === 'object'
          ? row.data
          : {};

      return res.json({
        success: true,
        user: {
          ...userData,
          id: row.id,
          name: row.name || userData.name || '',
          email: row.email || userData.email || ''
        }
      });

    } catch (error) {
      console.error('Get current user error:', error);

      return res.status(500).json({
        success: false,
        error: 'Failed to load user'
      });
    }
  }
);


// ------------------------------------------------------------
// UPDATE CUSTOMER
// ------------------------------------------------------------

app.put(
  '/api/auth/me',
  tenantMiddleware,
  requireUser,
  async (req, res) => {
    try {
      const {
        name,
        phone,
        address
      } = req.body || {};

      const current = await dbQuery(
        `
        SELECT *
        FROM users
        WHERE id = $1
          AND tenant_id = $2
        LIMIT 1
        `,
        [req.userId, req.tenantId]
      );

      if (current.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      const row = current.rows[0];

      const oldData =
        row.data && typeof row.data === 'object'
          ? row.data
          : {};

      const updatedData = {
        ...oldData,
        id: row.id,
        name:
          name !== undefined
            ? String(name).trim()
            : oldData.name || row.name || '',
        email: row.email,
        phone:
          phone !== undefined
            ? String(phone).trim()
            : oldData.phone || '',
        address:
          address !== undefined
            ? String(address).trim()
            : oldData.address || ''
      };

      await dbQuery(
        `
        UPDATE users
        SET
          name = $1,
          data = $2::jsonb
        WHERE id = $3
          AND tenant_id = $4
        `,
        [
          updatedData.name,
          JSON.stringify(updatedData),
          req.userId,
          req.tenantId
        ]
      );

      return res.json({
        success: true,
        user: updatedData
      });

    } catch (error) {
      console.error('Update user error:', error);

      return res.status(500).json({
        success: false,
        error: 'Failed to update user'
      });
    }
  }
);


// ============================================================
// STORE APIs
// ============================================================


// ------------------------------------------------------------
// STORE PRODUCTS
// ------------------------------------------------------------

app.get(
  '/api/store/products',
  tenantMiddleware,
  async (req, res) => {
    try {
      const result = await dbQuery(
        `
        SELECT
          id,
          data
        FROM products
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        `,
        [req.tenantId]
      );

      const products = result.rows.map(row => {
        const data =
          row.data && typeof row.data === 'object'
            ? row.data
            : {};

        return {
          ...data,
          id: row.id
        };
      });

      return res.json({
        success: true,
        products
      });

    } catch (error) {
      console.error('Store products error:', error);

      return res.status(500).json({
        success: false,
        error: 'Failed to load products'
      });
    }
  }
);


// ------------------------------------------------------------
// STORE BRAND
// ------------------------------------------------------------

app.get(
  '/api/store/brand',
  tenantMiddleware,
  async (req, res) => {
    try {
      const brand = await getBrand(req.tenantId);

      const normalizedBrand = {
        ...brand,
        deliveryFee: Math.max(
          0,
          Number(brand?.deliveryFee) || 0
        ),
        deliveryFees: normalizeDeliveryFees(
          brand?.deliveryFees,
          brand?.deliveryFee || 0
        )
      };

      return res.json({
        success: true,
        brand: normalizedBrand
      });

    } catch (error) {
      console.error('Store brand error:', error);

      return res.status(500).json({
        success: false,
        error: 'Failed to load brand'
      });
    }
  }
);


// ============================================================
// CREATE AUTHENTICATED ORDER
// ============================================================

app.post(
  '/api/store/orders',
  tenantMiddleware,
  requireUser,
  async (req, res) => {
    try {
      const body = req.body || {};

      const items = Array.isArray(body.items)
        ? body.items
        : [];

      if (items.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Order must contain at least one item'
        });
      }

      // قراءة المحافظة
      const customerGovernorate =
        String(body.customerGovernorate || '').trim();

      if (
        !customerGovernorate ||
        !DELIVERY_GOVERNORATES[customerGovernorate]
      ) {
        return res.status(400).json({
          success: false,
          error: 'يجب اختيار المحافظة'
        });
      }

      // قراءة سعر التوصيل حسب المحافظة
      const brand = await getBrand(req.tenantId);

      const deliveryFee =
        getDeliveryFeeForGovernorate(
          brand,
          customerGovernorate
        );

      // حساب الإجمالي من السيرفر
      const subtotal = items.reduce(
        (sum, item) => {
          const price = Number(item.price) || 0;
          const quantity = Number(item.quantity) || 0;

          return sum + (price * quantity);
        },
        0
      );

      const totalPrice =
        subtotal + deliveryFee;

      const order = {
        ...body,

        id: uuidv4(),

        items,

        subtotal,

        customerGovernorate,

        deliveryFee,

        totalPrice,

        userId: req.userId,

        tenantId: req.tenantId,

        createdAt: new Date().toISOString(),

        status: 'new'
      };

      await dbQuery(
        `
        INSERT INTO orders (
          id,
          tenant_id,
          user_id,
          data
        )
        VALUES ($1, $2, $3, $4::jsonb)
        `,
        [
          order.id,
          req.tenantId,
          req.userId,
          JSON.stringify(order)
        ]
      );

      return res.status(201).json({
        success: true,
        order
      });

    } catch (error) {
      console.error('Create order error:', error);

      return res.status(500).json({
        success: false,
        error: 'Failed to create order'
      });
    }
  }
);


// ============================================================
// CREATE GUEST ORDER
// ============================================================

app.post(
  '/api/store/orders/guest',
  tenantMiddleware,
  async (req, res) => {
    try {
      const body = req.body || {};

      const items = Array.isArray(body.items)
        ? body.items
        : [];

      if (items.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Order must contain at least one item'
        });
      }

      // قراءة المحافظة
      const customerGovernorate =
        String(body.customerGovernorate || '').trim();

      if (
        !customerGovernorate ||
        !DELIVERY_GOVERNORATES[customerGovernorate]
      ) {
        return res.status(400).json({
          success: false,
          error: 'يجب اختيار المحافظة'
        });
      }

      const brand = await getBrand(req.tenantId);

      // حساب التوصيل حسب المحافظة من السيرفر
      const deliveryFee =
        getDeliveryFeeForGovernorate(
          brand,
          customerGovernorate
        );

      const subtotal = items.reduce(
        (sum, item) => {
          const price = Number(item.price) || 0;
          const quantity = Number(item.quantity) || 0;

          return sum + (price * quantity);
        },
        0
      );

      const totalPrice =
        subtotal + deliveryFee;

      const order = {
        ...body,

        id: uuidv4(),

        items,

        subtotal,

        customerGovernorate,

        deliveryFee,

        totalPrice,

        userId: null,

        tenantId: req.tenantId,

        createdAt: new Date().toISOString(),

        status: 'new'
      };

      await dbQuery(
        `
        INSERT INTO orders (
          id,
          tenant_id,
          user_id,
          data
        )
        VALUES ($1, $2, NULL, $3::jsonb)
        `,
        [
          order.id,
          req.tenantId,
          JSON.stringify(order)
        ]
      );

      return res.status(201).json({
        success: true,
        order
      });

    } catch (error) {
      console.error('Guest order error:', error);

      return res.status(500).json({
        success: false,
        error: 'Failed to create order'
      });
    }
  }
);


// ============================================================
// CUSTOMER ORDERS
// ============================================================

app.get(
  '/api/store/orders',
  tenantMiddleware,
  requireUser,
  async (req, res) => {
    try {
      const result = await dbQuery(
        `
        SELECT
          id,
          data
        FROM orders
        WHERE tenant_id = $1
          AND user_id = $2
        ORDER BY created_at DESC
        `,
        [
          req.tenantId,
          req.userId
        ]
      );

      const orders = result.rows.map(row => {
        const data =
          row.data && typeof row.data === 'object'
            ? row.data
            : {};

        return {
          ...data,
          id: row.id
        };
      });

      return res.json({
        success: true,
        orders
      });

    } catch (error) {
      console.error('Customer orders error:', error);

      return res.status(500).json({
        success: false,
        error: 'Failed to load orders'
      });
    }
  }
);


// ============================================================
// ROOT PAGE
// ============================================================

app.get('/', (req, res) => {
  const host = req.headers.host || '';

  const siteMode =
    req.headers['x-site-mode'] || '';

  if (
    siteMode === 'admin' ||
    host.includes('admin')
  ) {
    return res.sendFile(
      path.join(
        __dirname,
        'public',
        'admin.html'
      )
    );
  }

  return res.sendFile(
    path.join(
      __dirname,
      'public',
      'store.html'
    )
  );
});


// ============================================================
// 404 HANDLER
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});


// ============================================================
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});


// ============================================================
// START SERVER
// ============================================================


async function startServer() {
  try {
    await testDatabaseConnection();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `Server running on port ${PORT}`
      );
    });

  } catch (error) {
    console.error(
      'Failed to start server:',
      error
    );

    process.exit(1);
  }
}

startServer();


// ============================================================
// EXPORT
// ============================================================

module.exports = app;