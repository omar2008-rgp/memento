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
// SAFE DATABASE CONNECTION TEST
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

async function getTenantByDomain(domain) {
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

function requirePlatformAdmin(req, res, next) {
  const password =
    req.headers['x-platform-password'] || '';

  if (!PLATFORM_ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      error: 'PLATFORM_ADMIN_PASSWORD is not configured'
    });
  }

  if (password !== PLATFORM_ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      error: 'Platform admin password is incorrect'
    });
  }

  next();
}
// ============================================================
// ADMIN AUTH
// ============================================================

const adminSessions =
  new Map();

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
// PLATFORM - TENANT MANAGEMENT
// ============================================================

// Create a new tenant/store
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

      // --------------------------------------------------------
      // Validation
      // --------------------------------------------------------

      if (!id || !slug || !name || !adminPassword) {
        return res.status(400).json({
          success: false,
          error:
            'id, slug, name and adminPassword are required'
        });
      }

      const cleanId =
        String(id).trim().toLowerCase();

      const cleanSlug =
        String(slug).trim().toLowerCase();

      const cleanName =
        String(name).trim();

      const cleanStoreDomain =
        storeDomain
          ? String(storeDomain).trim().toLowerCase()
          : null;

      const cleanAdminDomain =
        adminDomain
          ? String(adminDomain).trim().toLowerCase()
          : null;

      // IDs/slugs must be simple URL-safe values
      const validId =
        /^[a-z0-9][a-z0-9-_]{1,49}$/.test(
          cleanId
        );

      const validSlug =
        /^[a-z0-9][a-z0-9-_]{1,49}$/.test(
          cleanSlug
        );

      if (!validId) {
        return res.status(400).json({
          success: false,
          error:
            'Invalid id. Use lowercase letters, numbers, - or _'
        });
      }

      if (!validSlug) {
        return res.status(400).json({
          success: false,
          error:
            'Invalid slug. Use lowercase letters, numbers, - or _'
        });
      }

      if (cleanName.length < 2) {
        return res.status(400).json({
          success: false,
          error:
            'Store name must contain at least 2 characters'
        });
      }

      if (String(adminPassword).length < 8) {
        return res.status(400).json({
          success: false,
          error:
            'Admin password must be at least 8 characters'
        });
      }

      // --------------------------------------------------------
      // Check duplicate tenant
      // --------------------------------------------------------

      const existingTenant =
        await dbQuery(
          `
          SELECT id, slug, store_domain, admin_domain
          FROM tenants
          WHERE id = $1
             OR slug = $2
             OR ($3::text IS NOT NULL AND store_domain = $3)
             OR ($4::text IS NOT NULL AND admin_domain = $4)
          LIMIT 1
          `,
          [
            cleanId,
            cleanSlug,
            cleanStoreDomain,
            cleanAdminDomain
          ]
        );

      if (existingTenant.rows.length > 0) {
        return res.status(409).json({
          success: false,
          error:
            'Tenant, slug or domain already exists',
          existing:
            existingTenant.rows[0]
        });
      }

      // --------------------------------------------------------
      // Hash admin password
      // --------------------------------------------------------

      const adminPasswordHash =
        await bcrypt.hash(
          String(adminPassword),
          12
        );

      // --------------------------------------------------------
      // Create tenant
      // --------------------------------------------------------

      const result =
        await dbQuery(
          `
          INSERT INTO tenants (
            id,
            slug,
            name,
            store_domain,
            admin_domain,
            admin_password_hash
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING
            id,
            slug,
            name,
            store_domain,
            admin_domain,
            created_at,
            updated_at
          `,
          [
            cleanId,
            cleanSlug,
            cleanName,
            cleanStoreDomain,
            cleanAdminDomain,
            adminPasswordHash
          ]
        );

      return res.status(201).json({
        success: true,
        message:
          'Tenant created successfully',
        tenant:
          result.rows[0]
      });

    } catch (error) {
      console.error(
        'Create tenant error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to create tenant',
        details:
          error.message
      });
    }
  }
);


// ------------------------------------------------------------
// List all tenants
// ------------------------------------------------------------

app.get(
  '/api/platform/tenants',
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const result =
        await dbQuery(
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
        tenants:
          result.rows
      });

    } catch (error) {
      console.error(
        'List tenants error:',
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


// ------------------------------------------------------------
// Get one tenant
// ------------------------------------------------------------

app.get(
  '/api/platform/tenants/:id',
  requirePlatformAdmin,
  async (req, res) => {
    try {
      const tenantId =
        String(req.params.id)
          .trim()
          .toLowerCase();

      const result =
        await dbQuery(
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

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error:
            'Tenant not found'
        });
      }

      return res.json({
        success: true,
        tenant:
          result.rows[0]
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
      const { password } = req.body || {};

      if (!password) {
        return res.status(401).json({
          error: 'كلمة المرور غير صحيحة'
        });
      }

      const tenant = req.tenant;
      let validPassword = false;

      // Each tenant has its own bcrypt admin password.
      if (tenant.admin_password_hash) {
        validPassword = await bcrypt.compare(
          password,
          tenant.admin_password_hash
        );
      }

      // Temporary compatibility for the existing Memento store.
      // On the first successful login, the password is converted
      // to a bcrypt hash and stored for the Memento tenant.
      else if (
        tenant.id === 'memento' &&
        ADMIN_PASSWORD
      ) {
        validPassword =
          password === ADMIN_PASSWORD;

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

          req.tenant.admin_password_hash =
            passwordHash;
        }
      }

      if (!validPassword) {
        return res.status(401).json({
          error: 'كلمة المرور غير صحيحة'
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

      res.json({
        success: true,
        token
      });

    } catch (error) {
      console.error(
        'Admin login error:',
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
      const brand = {
        ...req.body,

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
// ADMIN ORDERS
// ============================================================

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
// REGISTER
// ============================================================

app.post(
  '/api/auth/register',
  tenantMiddleware,
  async (
    req,
    res
  ) => {
    try {
      const {
        name,
        email,
        password,
        phone,
        address
      } = req.body;

      if (
        !name ||
        !email ||
        !password ||
        !phone ||
        !address
      ) {
        return res.status(400).json({
          error:
            'جميع الحقول مطلوبة'
        });
      }

      const normalizedEmail =
        String(email)
          .trim()
          .toLowerCase();

      const existing =
        await dbQuery(
          `
            SELECT id
            FROM users
            WHERE email = $1
              AND tenant_id = $2
          `,
          [
            normalizedEmail,
            req.tenantId
          ]
        );

      if (
        existing.rows[0]
      ) {
        return res.status(400).json({
          error:
            'البريد الإلكتروني مستخدم بالفعل'
        });
      }

      const hashedPassword =
        await bcrypt.hash(
          password,
          10
        );

      const newUser = {
        id:
          uuidv4(),

        name,

        email:
          normalizedEmail,

        password:
          hashedPassword,

        phone,

        address,

        createdAt:
          new Date()
            .toISOString()
      };

      await dbQuery(
        `
          INSERT INTO users (
            id,
            email,
            data,
            tenant_id
          )
          VALUES (
            $1,
            $2,
            $3,
            $4
          )
        `,
        [
          newUser.id,
          newUser.email,
          newUser,
          req.tenantId
        ]
      );

      res.status(201).json({
        success: true,

        token:
          generateToken(
            newUser.id,
            req.tenantId
          ),

        user: {
          id:
            newUser.id,

          name:
            newUser.name,

          email:
            newUser.email,

          phone:
            newUser.phone,

          address:
            newUser.address
        }
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
// LOGIN
// ============================================================

app.post(
  '/api/auth/login',
  tenantMiddleware,
  async (
    req,
    res
  ) => {
    try {
      const {
        email,
        password
      } = req.body;

      if (
        !email ||
        !password
      ) {
        return res.status(400).json({
          error:
            'البريد الإلكتروني وكلمة المرور مطلوبان'
        });
      }

      const normalizedEmail =
        String(email)
          .trim()
          .toLowerCase();

      const {
        rows
      } = await dbQuery(
        `
          SELECT data
          FROM users
          WHERE email = $1
            AND tenant_id = $2
        `,
        [
          normalizedEmail,
          req.tenantId
        ]
      );

      const user =
        rows[0]?.data;

      if (!user) {
        return res.status(401).json({
          error:
            'البريد الإلكتروني غير صحيح'
        });
      }

      const valid =
        await bcrypt.compare(
          password,
          user.password
        );

      if (!valid) {
        return res.status(401).json({
          error:
            'كلمة المرور غير صحيحة'
        });
      }

      res.json({
        success: true,

        token:
          generateToken(
            user.id,
            req.tenantId
          ),

        user: {
          id:
            user.id,

          name:
            user.name,

          email:
            user.email,

          phone:
            user.phone,

          address:
            user.address
        }
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
// CURRENT USER
// ============================================================

app.get(
  '/api/auth/me',
  tenantMiddleware,
  authenticateUser,
  async (
    req,
    res
  ) => {
    try {
      const {
        rows
      } = await dbQuery(
        `
          SELECT data
          FROM users
          WHERE id = $1
            AND tenant_id = $2
        `,
        [
          req.userId,
          req.tenantId
        ]
      );

      const user =
        rows[0]?.data;

      if (!user) {
        return res.status(404).json({
          error:
            'User not found'
        });
      }

      res.json({
        id:
          user.id,

        name:
          user.name,

        email:
          user.email,

        phone:
          user.phone,

        address:
          user.address
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
// UPDATE CURRENT USER
// ============================================================

app.put(
  '/api/auth/me',
  tenantMiddleware,
  authenticateUser,
  async (
    req,
    res
  ) => {
    try {
      const {
        rows
      } = await dbQuery(
        `
          SELECT data
          FROM users
          WHERE id = $1
            AND tenant_id = $2
        `,
        [
          req.userId,
          req.tenantId
        ]
      );

      if (!rows[0]) {
        return res.status(404).json({
          error:
            'User not found'
        });
      }

      const user =
        rows[0].data;

      const {
        name,
        phone,
        address,
        password
      } = req.body;

      if (name) {
        user.name =
          name;
      }

      if (phone) {
        user.phone =
          phone;
      }

      if (address) {
        user.address =
          address;
      }

      if (password) {
        user.password =
          await bcrypt.hash(
            password,
            10
          );
      }

      await dbQuery(
        `
          UPDATE users
          SET
            data = $1,
            updated_at = NOW()
          WHERE id = $2
            AND tenant_id = $3
        `,
        [
          user,
          req.userId,
          req.tenantId
        ]
      );

      res.json({
        success: true,

        user: {
          id:
            user.id,

          name:
            user.name,

          email:
            user.email,

          phone:
            user.phone,

          address:
            user.address
        }
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
// STORE PRODUCTS
// ============================================================

app.get(
  '/api/store/products',
  tenantMiddleware,
  async (
    req,
    res
  ) => {
    try {
      const products =
        await getProducts(
          req.tenantId
        );

      res.json(
        products.map(
          product => ({
            id:
              product.id,

            name:
              product.name,

            price:
              product.price,

            description:
              product.description,

            images:
              product.images,

            quantity:
              product.quantity > 10
                ? null
                : product.quantity
          })
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
// STORE BRAND
// ============================================================

app.get(
  '/api/store/brand',
  tenantMiddleware,
  async (
    req,
    res
  ) => {
    try {
      const brand =
        await getBrand(
          req.tenantId
        );

      if (!brand) {
        return res.json(
          null
        );
      }

      res.json({
        name:
          brand.name,

        logo:
          brand.logo,

        phone:
          brand.phone,

        email:
          brand.email,

        instagram:
          brand.instagram,

        tiktok:
          brand.tiktok,

        whatsapp:
          brand.whatsapp,

        facebook:
          brand.facebook
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
// STORE ORDERS
// ============================================================

app.post(
  '/api/store/orders',
  tenantMiddleware,
  authenticateUser,
  async (
    req,
    res
  ) => {
    try {
      const order = {
        ...req.body,

        userId:
          req.userId,

        id:
          uuidv4(),

        createdAt:
          new Date()
            .toISOString(),

        status:
          'new'
      };

      await dbQuery(
        `
          INSERT INTO orders (
            id,
            user_id,
            data,
            tenant_id
          )
          VALUES (
            $1,
            $2,
            $3,
            $4
          )
        `,
        [
          order.id,
          order.userId,
          order,
          req.tenantId
        ]
      );

      res.json({
        success: true,
        order
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
// GUEST ORDERS
// ============================================================

app.post(
  '/api/store/orders/guest',
  tenantMiddleware,
  async (
    req,
    res
  ) => {
    try {
      const order = {
        ...req.body,

        userId:
          null,

        id:
          uuidv4(),

        createdAt:
          new Date()
            .toISOString(),

        status:
          'new'
      };

      await dbQuery(
        `
          INSERT INTO orders (
            id,
            user_id,
            data,
            tenant_id
          )
          VALUES (
            $1,
            $2,
            $3,
            $4
          )
        `,
        [
          order.id,
          null,
          order,
          req.tenantId
        ]
      );

      res.json({
        success: true,
        order
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
// ROOT
// ============================================================

app.get(
  '/',
  tenantMiddleware,
  (
    req,
    res
  ) => {
    const host =
      req.headers.host ||
      '';

    const siteMode =
      req.headers[
        'x-site-mode'
      ] || '';

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

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'store.html'
      )
    );
  }
);

// ============================================================
// START
// ============================================================

async function start() {
  await testDatabaseConnection();

  app.listen(
    PORT,
    () => {
      console.log(
        `✅ Server running on port ${PORT}`
      );
    }
  );
}

start();

module.exports = app;