const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value?.startsWith("--")) {
    continue;
  }

  const next = process.argv[index + 1];
  args.set(value.slice(2), next && !next.startsWith("--") ? next : "true");
}

const config = {
  baseUrl: args.get("base-url") ?? process.env.BASE_URL ?? "http://localhost:8080",
  orders: parseInteger(args.get("orders") ?? process.env.SEED_ORDERS ?? "1000", "orders"),
  concurrency: parseInteger(
    args.get("concurrency") ?? process.env.SEED_CONCURRENCY ?? "25",
    "concurrency",
  ),
  email: args.get("email") ?? process.env.SEED_USER_EMAIL ?? "seed@example.com",
  password:
    args.get("password") ?? process.env.SEED_USER_PASSWORD ?? "correct-horse-battery-staple",
};

function parseInteger(raw, name) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function seedIp(index) {
  const third = Math.floor(index / 250) % 250;
  const fourth = index % 250;
  return `10.77.${third}.${fourth}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${config.baseUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${path}: ${text}`);
    error.response = response;
    error.body = body;
    throw error;
  }

  return body;
}

async function authenticate() {
  const body = {
    email: config.email,
    password: config.password,
  };

  try {
    const registered = await request("/v1/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.77.255.1",
      },
      body: JSON.stringify(body),
    });
    return registered.accessToken;
  } catch (error) {
    if (error.response?.status !== 409) {
      throw error;
    }
  }

  const loggedIn = await request("/v1/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": "10.77.255.2",
    },
    body: JSON.stringify(body),
  });
  return loggedIn.accessToken;
}

function orderBody(index) {
  const quantity = (index % 5) + 1;
  const unitPriceCents = 500 + (index % 200) * 37;
  return {
    customerEmail: `seed-buyer-${index}@example.com`,
    items: [
      {
        sku: `SEED-${String(index % 1000).padStart(4, "0")}`,
        quantity,
        unitPriceCents,
      },
      {
        sku: `ADDON-${String(index % 250).padStart(4, "0")}`,
        quantity: 1,
        unitPriceCents: 199,
      },
    ],
  };
}

async function createOrder(index, accessToken) {
  return request("/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "X-Forwarded-For": seedIp(index),
    },
    body: JSON.stringify(orderBody(index)),
  });
}

async function runWorker(workerId, accessToken, cursor) {
  while (true) {
    const index = cursor.next();
    if (index > config.orders) {
      return;
    }

    try {
      await createOrder(index, accessToken);
      if (index % 100 === 0 || index === config.orders) {
        console.log(`Seeded ${index}/${config.orders} orders`);
      }
    } catch (error) {
      console.error(`Worker ${workerId} failed on order ${index}`);
      throw error;
    }
  }
}

async function main() {
  console.log(
    `Seeding ${config.orders} orders through ${config.baseUrl} with concurrency ${config.concurrency}`,
  );
  const accessToken = await authenticate();
  let current = 0;
  const cursor = {
    next() {
      current += 1;
      return current;
    },
  };

  await Promise.all(
    Array.from({ length: config.concurrency }, (_, index) =>
      runWorker(index + 1, accessToken, cursor),
    ),
  );
  console.log(`Done. Seeded ${config.orders} orders.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
