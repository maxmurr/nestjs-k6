import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// =============================================================================
// CUSTOM METRICS
// =============================================================================
// Trend  — tracks a distribution of values (min, max, avg, percentiles)
// Rate   — tracks the percentage of non-zero values (good for pass/fail ratios)

const userListDuration = new Trend('user_list_duration', true); // true = time values
const creationSuccess = new Rate('user_creation_success');

// =============================================================================
// TAG HELPERS
// =============================================================================
// The `name` tag partitions built-in HTTP metrics (http_req_duration, etc.)
// per endpoint, so each API's performance is tracked independently.

function taggedParams(name, extra = {}) {
  return { ...extra, tags: { ...extra.tags, name } };
}

// =============================================================================
// OPTIONS — configure how the load test behaves
// =============================================================================
export const options = {
  // Stages ramp virtual users (VUs) up and down over time.
  // This simulates realistic traffic: gradual increase → peak → wind down.
  stages: [
    { duration: '10s', target: 10 }, // ramp up to 10 VUs over 10 seconds
    { duration: '20s', target: 10 }, // hold at 10 VUs for 20 seconds (steady state)
    { duration: '10s', target: 0 }, // ramp down to 0 VUs over 10 seconds
  ],

  // Thresholds define pass/fail criteria for the entire test run.
  // If any threshold is violated, k6 exits with a non-zero code — useful for CI/CD.
  //
  // Tagged thresholds (e.g. http_req_duration{name:GET /users}) give each
  // endpoint its own independent pass/fail criteria and metric breakdown.
  thresholds: {
    // Global thresholds — apply across all requests
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.95'],

    // Per-endpoint thresholds — independent performance criteria
    'http_req_duration{name:GET /users}': ['p(95)<300'],
    'http_req_duration{name:GET /users/:id}': ['p(95)<200'],
    'http_req_duration{name:POST /users}': ['p(95)<500'],
    'http_req_duration{name:PUT /users/:id}': ['p(95)<400'],
    'http_req_duration{name:DELETE /users/:id}': ['p(95)<300'],

    // Custom metrics
    user_list_duration: ['p(95)<400'],
    user_creation_success: ['rate>0.90'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

// =============================================================================
// SETUP — runs once before the test starts (not per VU)
// =============================================================================
// Use setup() to prepare test data. The return value is passed to the default
// function and teardown(). This runs with a single VU.

export function setup() {
  // Verify the API is reachable before running the full test
  const res = http.get(`${BASE_URL}/users`);
  check(res, {
    'setup: API is reachable': (r) => r.status === 200,
  });

  // Create a user specifically for update/delete tests so we don't collide
  // with other VUs modifying the same resource.
  const payload = JSON.stringify({
    name: 'Setup User',
    email: 'setup@example.com',
  });
  const params = { headers: { 'Content-Type': 'application/json' } };
  const createRes = http.post(`${BASE_URL}/users`, payload, params);

  const setupUser = createRes.json();
  console.log(`Setup: created user #${setupUser.id} for write tests`);

  return { setupUserId: setupUser.id };
}

// =============================================================================
// DEFAULT FUNCTION — runs once per iteration, per VU
// =============================================================================
// This is the main test logic. Each VU loops through this function continuously
// for the duration of the test. Use groups to organize related requests.

export default function (data) {
  const params = { headers: { 'Content-Type': 'application/json' } };

  // ---------------------------------------------------------------------------
  // Group: Read Operations
  // ---------------------------------------------------------------------------
  // Groups let you organize requests logically. In the summary output you'll
  // see metrics broken down by group name.

  group('Read Operations', () => {
    // GET /users — list all users
    const listRes = http.get(`${BASE_URL}/users`, taggedParams('GET /users'));

    // check() validates response properties. Each check is a name + predicate.
    // Failed checks don't stop the test — they're tallied in the results.
    check(listRes, {
      'GET /users returns 200': (r) => r.status === 200,
      'GET /users returns array': (r) => Array.isArray(r.json()),
    });

    // Feed our custom Trend metric with the response time
    userListDuration.add(listRes.timings.duration);

    // GET /users/:id — fetch a single user
    const getRes = http.get(`${BASE_URL}/users/1`, taggedParams('GET /users/:id'));
    check(getRes, {
      'GET /users/1 returns 200': (r) => r.status === 200,
      'GET /users/1 has correct id': (r) => r.json('id') === 1,
    });
  });

  // ---------------------------------------------------------------------------
  // Group: Write Operations
  // ---------------------------------------------------------------------------

  group('Write Operations', () => {
    // POST /users — create a new user
    const createPayload = JSON.stringify({
      name: `User ${Date.now()}`,
      email: `user-${Date.now()}@test.com`,
    });
    const createRes = http.post(
      `${BASE_URL}/users`,
      createPayload,
      taggedParams('POST /users', params),
    );

    const created = check(createRes, {
      'POST /users returns 201': (r) => r.status === 201,
      'POST /users returns id': (r) => r.json('id') !== undefined,
    });

    // Feed our custom Rate metric (1 = success, 0 = failure)
    creationSuccess.add(created ? 1 : 0);

    // PUT /users/:id — update the user created in setup()
    if (data.setupUserId) {
      const updatePayload = JSON.stringify({
        name: `Updated ${Date.now()}`,
      });
      const updateRes = http.put(
        `${BASE_URL}/users/${data.setupUserId}`,
        updatePayload,
        taggedParams('PUT /users/:id', params),
      );
      check(updateRes, {
        'PUT /users/:id returns 200': (r) => r.status === 200,
      });
    }

    // DELETE — only delete the user we just created (not the setup user)
    if (created && createRes.json('id')) {
      const newId = createRes.json('id');
      const deleteRes = http.del(
        `${BASE_URL}/users/${newId}`,
        null,
        taggedParams('DELETE /users/:id'),
      );
      check(deleteRes, {
        'DELETE /users/:id returns 200': (r) => r.status === 200,
      });
    }
  });

  // Sleep between iterations to simulate realistic user think-time.
  // Without this, each VU would hammer the API as fast as possible.
  sleep(1);
}

// =============================================================================
// TEARDOWN — runs once after the test ends
// =============================================================================
// Clean up any resources created during the test. Receives the same data
// returned by setup().

export function teardown(data) {
  if (data.setupUserId) {
    http.del(`${BASE_URL}/users/${data.setupUserId}`);
    console.log(`Teardown: deleted setup user #${data.setupUserId}`);
  }
}

// =============================================================================
// SUMMARY
// =============================================================================
// k6 automatically prints a detailed summary to stdout when the test ends,
// including all HTTP metrics (duration, rate, failures), checks, thresholds,
// and custom metrics. No custom handleSummary() needed — the defaults are good.
