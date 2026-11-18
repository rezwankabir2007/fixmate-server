import "dotenv/config";
import { MongoClient } from "mongodb";

const BASE = "http://localhost:5000";
const ORIGIN = BASE;

const results = [];
let failures = 0;

function check(name, condition, detail) {
  results.push(`${condition ? "PASS" : "FAIL"} | ${name} | ${detail}`);
  if (!condition) failures++;
}

async function api(method, path, { body, cookie, query } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const headers = {
    // Reproduce the Next.js proxy headers: Better Auth requires a trusted
    // Origin, and requireSameOrigin compares Origin against x-forwarded-host.
    Origin: "http://localhost:3000",
    "x-forwarded-host": "localhost:3000",
    "x-forwarded-proto": "http",
  };
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: payload });
  const setCookies = res.headers.getSetCookie();
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return {
    status: res.status,
    data,
    newCookie: setCookies.map((c) => c.split(";")[0]).join("; "),
  };
}

const stamp = Date.now();
const future = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
const past = new Date(Date.now() - 3600 * 1000).toISOString();

const credentials = {
  customer: { email: `book.customer.${stamp}@example.com`, password: "Passw0rd!", name: "Booking Customer" },
  technician: { email: `book.tech.${stamp}@example.com`, password: "Passw0rd!", name: "Booking Tech" },
  admin: { email: `book.admin.${stamp}@example.com`, password: "Passw0rd!", name: "Booking Admin" },
  bystander: { email: `book.other.${stamp}@example.com`, password: "Passw0rd!", name: "Booking Bystander" },
};

async function signUp(kind) {
  const c = credentials[kind];
  const res = await api("POST", "/api/auth/sign-up/email", {
    body: { ...c, role: kind === "technician" ? "technician" : "customer" },
  });
  return { status: res.status, cookie: res.newCookie };
}

async function signIn(kind) {
  const c = credentials[kind];
  const res = await api("POST", "/api/auth/sign-in/email", {
    body: { email: c.email, password: c.password },
  });
  return { status: res.status, cookie: res.newCookie };
}

// --- 0. health ---
const health = await api("GET", "/api/health");
check("health", health.status === 200, `status=${health.status}`);

// --- 1. signups ---
const tech = await signUp("technician");
check("technician signup", tech.status === 200 && Boolean(tech.cookie), `status=${tech.status}`);
const cust = await signUp("customer");
check("customer signup", cust.status === 200 && Boolean(cust.cookie), `status=${cust.status}`);
const adm = await signUp("admin");
check("admin candidate signup", adm.status === 200 && Boolean(adm.cookie), `status=${adm.status}`);
const bystander = await signUp("bystander");
check("bystander signup", bystander.status === 200 && Boolean(bystander.cookie), `status=${bystander.status}`);

// --- 2. promote admin candidate directly in the dev database ---
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const users = client.db("fixmate").collection("user");
const promoted = await users.updateOne(
  { email: credentials.admin.email },
  { $set: { role: "admin" } },
);
check("admin promotion", promoted.modifiedCount === 1, `modified=${promoted.modifiedCount}`);
const adminCount = await users.countDocuments({ role: "admin" });
check("admin exists", adminCount >= 1, `admins=${adminCount}`);
await client.close();

const adminInfo = await signIn("admin");
check("admin signin", adminInfo.status === 200 && Boolean(adminInfo.cookie), `status=${adminInfo.status}`);

// --- 3. technician creates a service ---
const servicePayload = {
  title: `API Test Repair ${stamp}`,
  category: "Smartphone",
  shortDescription: "Screen replacement performed by automated test.",
  description: "Full description of the automated API test repair service listing.",
  price: 79.5,
  duration: "1-2 hours",
  image: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
  serviceMode: "In-store",
};
const serviceRes = await api("POST", "/api/technician/services", { body: servicePayload, cookie: tech.cookie });
check("create service", serviceRes.status === 201, `status=${serviceRes.status} body=${JSON.stringify(serviceRes.data)}`);
const serviceId = serviceRes.data?.data?.id;

// --- 4. admin approval ---
const approve = await api("PATCH", `/api/admin/services/${serviceId}`, { body: { status: "approved" }, cookie: adminInfo.cookie });
check("admin approves service", approve.status === 200, `status=${approve.status} body=${JSON.stringify(approve.data)}`);

// --- 5. validation before any booking ---
const pastRes = await api("POST", "/api/bookings", {
  body: { serviceId, scheduledFor: past, address: "12 Test Street, Apt 4" },
  cookie: cust.cookie,
});
check("past schedule rejected", pastRes.status === 400, `status=${pastRes.status}`);

const shortAddr = await api("POST", "/api/bookings", {
  body: { serviceId, scheduledFor: future, address: "short" },
  cookie: cust.cookie,
});
check("short address rejected", shortAddr.status === 400, `status=${shortAddr.status}`);

const noOriginRes = await fetch(`${BASE}/api/bookings/mine`, { headers: { Cookie: cust.cookie } });
check("missing Origin rejected", noOriginRes.status === 403, `status=${noOriginRes.status}`);

const anon = await api("GET", "/api/bookings/mine");
check("anonymous rejected", anon.status === 401, `status=${anon.status}`);

const techBooking = await api("POST", "/api/bookings", {
  body: { serviceId, scheduledFor: future, address: "12 Test Street, Apt 4" },
  cookie: tech.cookie,
});
check("technician cannot book", techBooking.status === 403, `status=${techBooking.status}`);

// --- 6. create booking 1 ---
const book1 = await api("POST", "/api/bookings", {
  body: { serviceId, scheduledFor: future, address: "12 Test Street, Apt 4", notes: "Please call on arrival." },
  cookie: cust.cookie,
});
check("create booking", book1.status === 201, `status=${book1.status} body=${JSON.stringify(book1.data)}`);
const booking1 = book1.data?.data;
check("booking has pending status", booking1?.status === "pending", `status=${booking1?.status}`);

const dup = await api("POST", "/api/bookings", {
  body: { serviceId, scheduledFor: future, address: "12 Test Street, Apt 4" },
  cookie: cust.cookie,
});
check("duplicate booking rejected", dup.status === 409, `status=${dup.status}`);

// --- 7. lists ---
const mine = await api("GET", "/api/bookings/mine", { cookie: cust.cookie });
const mineHas = Array.isArray(mine.data?.data) && mine.data.data.some((b) => b.id === booking1?.id);
check("customer mine list", mine.status === 200 && mineHas, `status=${mine.status} count=${mine.data?.data?.length}`);

const assigned = await api("GET", "/api/bookings/assigned", { cookie: tech.cookie });
const assignedHas = Array.isArray(assigned.data?.data) && assigned.data.data.some((b) => b.id === booking1?.id);
check("technician assigned list", assigned.status === 200 && assignedHas, `status=${assigned.status} count=${assigned.data?.data?.length}`);

const all = await api("GET", "/api/bookings", { cookie: adminInfo.cookie });
const allHas = Array.isArray(all.data?.data) && all.data.data.some((b) => b.id === booking1?.id);
check("admin all list", all.status === 200 && allHas, `status=${all.status} total=${all.data?.total}`);

const filtered = await api("GET", "/api/bookings", { cookie: adminInfo.cookie, query: { status: "pending" } });
check("admin status filter", filtered.status === 200 && filtered.data.data.every((b) => b.status === "pending"), `status=${filtered.status}`);

const badFilter = await api("GET", "/api/bookings", { cookie: adminInfo.cookie, query: { status: "bogus" } });
check("admin bad filter rejected", badFilter.status === 400, `status=${badFilter.status}`);

const custAll = await api("GET", "/api/bookings", { cookie: cust.cookie });
check("customer cannot list all", custAll.status === 403, `status=${custAll.status}`);

// --- 8. transition rules ---
const wrongRole = await api("PATCH", `/api/bookings/${booking1?.id}/status`, { body: { status: "accepted" }, cookie: cust.cookie });
check("customer cannot accept", wrongRole.status === 409, `status=${wrongRole.status}`);

const wrongTarget = await api("PATCH", `/api/bookings/${booking1?.id}/status`, { body: { status: "completed" }, cookie: tech.cookie });
check("pending cannot jump to completed", wrongTarget.status === 409, `status=${wrongTarget.status}`);

const badStatus = await api("PATCH", `/api/bookings/${booking1?.id}/status`, { body: { status: "bogus" }, cookie: tech.cookie });
check("invalid status rejected", badStatus.status === 400, `status=${badStatus.status}`);

// --- 9. service delete blocked by active booking ---
const deleteBlocked = await api("DELETE", `/api/technician/services/${serviceId}`, { cookie: tech.cookie });
check("delete blocked by active booking", deleteBlocked.status === 409, `status=${deleteBlocked.status}`);

const otherDelete = await api("DELETE", `/api/technician/services/${serviceId}`, { cookie: cust.cookie });
check("non-owner delete rejected", otherDelete.status === 403 || otherDelete.status === 404, `status=${otherDelete.status}`);

// --- 10. happy-path transitions ---
const accept = await api("PATCH", `/api/bookings/${booking1?.id}/status`, { body: { status: "accepted" }, cookie: tech.cookie });
check("technician accepts", accept.status === 200 && accept.data?.data?.status === "accepted", `status=${accept.status}`);

const detail = await api("GET", `/api/bookings/${booking1?.id}`, { cookie: cust.cookie });
check("participant detail", detail.status === 200, `status=${detail.status}`);

const missing = await api("GET", "/api/bookings/deadbeefdeadbeefdeadbeef", { cookie: cust.cookie });
check("missing booking 404", missing.status === 404, `status=${missing.status}`);

const complete = await api("PATCH", `/api/bookings/${booking1?.id}/status`, { body: { status: "completed" }, cookie: tech.cookie });
check("technician completes", complete.status === 200 && complete.data?.data?.status === "completed", `status=${complete.status}`);

const completeAgain = await api("PATCH", `/api/bookings/${booking1?.id}/status`, { body: { status: "completed" }, cookie: tech.cookie });
check("terminal state protected", completeAgain.status === 409, `status=${completeAgain.status}`);

// booking 2: technician declines
const book2 = await api("POST", "/api/bookings", {
  body: { serviceId, scheduledFor: future, address: "99 Another Road, Suite 12" },
  cookie: cust.cookie,
});
const booking2 = book2.data?.data;
check("second booking", book2.status === 201, `status=${book2.status}`);
const decline = await api("PATCH", `/api/bookings/${booking2?.id}/status`, { body: { status: "declined" }, cookie: tech.cookie });
check("technician declines", decline.status === 200 && decline.data?.data?.status === "declined", `status=${decline.status}`);

// booking 3: customer cancels
const book3 = await api("POST", "/api/bookings", {
  body: { serviceId, scheduledFor: future, address: "7 Cancel Lane, Floor 3" },
  cookie: cust.cookie,
});
const booking3 = book3.data?.data;
check("third booking", book3.status === 201, `status=${book3.status}`);
const cancel = await api("PATCH", `/api/bookings/${booking3?.id}/status`, { body: { status: "cancelled" }, cookie: cust.cookie });
check("customer cancels", cancel.status === 200 && cancel.data?.data?.status === "cancelled", `status=${cancel.status}`);

// admin override
const adminOverride = await api("PATCH", `/api/bookings/${booking3?.id}/status`, { body: { status: "completed" }, cookie: adminInfo.cookie });
check("admin override transition", adminOverride.status === 200 && adminOverride.data?.data?.status === "completed", `status=${adminOverride.status}`);

const stranger = await api("GET", `/api/bookings/${booking1?.id}`, { cookie: bystander.cookie });
check("stranger cannot read booking", stranger.status === 404, `status=${stranger.status}`);

const strangerPatch = await api("PATCH", `/api/bookings/${booking1?.id}/status`, { body: { status: "cancelled" }, cookie: bystander.cookie });
check("stranger cannot update booking", strangerPatch.status === 404, `status=${strangerPatch.status}`);

// --- 11. profile + admin accounts ---
const profile = await api("GET", "/api/dashboard/profile", { cookie: cust.cookie });
check("profile read", profile.status === 200 && profile.data?.data?.email === credentials.customer.email, `status=${profile.status}`);

const accounts = await api("GET", "/api/admin/accounts", { cookie: adminInfo.cookie });
check("admin accounts list", accounts.status === 200 && Array.isArray(accounts.data?.data), `status=${accounts.status} count=${accounts.data?.data?.length}`);

const accountsDenied = await api("GET", "/api/admin/accounts", { cookie: cust.cookie });
check("customer denied accounts", accountsDenied.status === 403, `status=${accountsDenied.status}`);

// --- 12. service delete now that no booking is active ---
const deleteOk = await api("DELETE", `/api/technician/services/${serviceId}`, { cookie: tech.cookie });
check("service delete", deleteOk.status === 200 && deleteOk.data?.data?.deleted === true, `status=${deleteOk.status}`);

const gone = await api("GET", `/api/services/${serviceId}`);
check("deleted service gone", gone.status === 404, `status=${gone.status}`);

// --- 13. public service list still works ---
const list = await api("GET", "/api/services");
check("public services list", list.status === 200, `status=${list.status}`);

console.log(results.join("\n"));
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
