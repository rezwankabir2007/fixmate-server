import "dotenv/config";
import { MongoClient } from "mongodb";

const BASE = "http://localhost:5000";

const results = [];
let failures = 0;

function check(name, condition, detail) {
  results.push(`${condition ? "PASS" : "FAIL"} | ${name} | ${detail}`);
  if (!condition) failures++;
}

async function api(method, path, { body, cookie, query, headers: extra } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const headers = {
    // Reproduce the Next.js proxy headers: Better Auth requires a trusted
    // Origin, and requireSameOrigin compares Origin against x-forwarded-host.
    Origin: "http://localhost:3000",
    "x-forwarded-host": "localhost:3000",
    "x-forwarded-proto": "http",
    ...(extra ?? {}),
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
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  return {
    status: res.status,
    data,
    newCookie: setCookies.map((c) => c.split(";")[0]).join("; "),
  };
}

function calendarDate(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const stamp = Date.now();

const credentials = {
  customer: { email: `book.customer.${stamp}@example.com`, password: "Passw0rd!", name: "Booking Customer" },
  technician: { email: `book.tech.${stamp}@example.com`, password: "Passw0rd!", name: "Booking Tech" },
  admin: { email: `book.admin.${stamp}@example.com`, password: "Passw0rd!", name: "Booking Admin" },
  bystander: { email: `book.other.${stamp}@example.com`, password: "Passw0rd!", name: "Booking Bystander" },
};

const validBody = (serviceId, overrides = {}) => ({
  serviceId,
  customerPhone: "+1 555 010 2030",
  address: "12 Test Street, Apt 4",
  preferredDate: calendarDate(2),
  problemDescription: "The phone screen flickers constantly and the battery drains fast.",
  ...overrides,
});

async function signUp(kind) {
  const c = credentials[kind];
  const res = await api("POST", "/api/auth/sign-up/email", {
    body: { ...c, role: kind.startsWith("technician") ? "technician" : "customer" },
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

// --- 1. signups + admin promotion ---
const tech = await signUp("technician");
check("technician signup", tech.status === 200 && Boolean(tech.cookie), `status=${tech.status}`);
const cust = await signUp("customer");
check("customer signup", cust.status === 200 && Boolean(cust.cookie), `status=${cust.status}`);
const adm = await signUp("admin");
check("admin candidate signup", adm.status === 200 && Boolean(adm.cookie), `status=${adm.status}`);
const bystander = await signUp("bystander");
check("bystander signup", bystander.status === 200 && Boolean(bystander.cookie), `status=${bystander.status}`);

// A second technician must never see another technician's requests.
credentials.technician2 = {
  email: `book.tech2.${stamp}@example.com`,
  password: "Passw0rd!",
  name: "Booking Tech Two",
};
const tech2 = await signUp("technician2");
check("second technician signup", tech2.status === 200 && Boolean(tech2.cookie), `status=${tech2.status}`);

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const users = client.db("fixmate").collection("user");
const promoted = await users.updateOne(
  { email: credentials.admin.email },
  { $set: { role: "admin" } },
);
check("admin promotion", promoted.modifiedCount === 1, `modified=${promoted.modifiedCount}`);
const adminInfo = await signIn("admin");
check("admin signin", adminInfo.status === 200 && Boolean(adminInfo.cookie), `status=${adminInfo.status}`);

// --- 2. technician creates services ---
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
const serviceRes = await api("POST", "/api/technician/services", {
  body: servicePayload,
  cookie: tech.cookie,
});
check(
  "create service",
  serviceRes.status === 201,
  `status=${serviceRes.status} body=${JSON.stringify(serviceRes.data)}`,
);
const serviceId = serviceRes.data?.data?.id;

// A second listing stays unapproved — it must be invisible publicly and
// unbookable.
const pendingServiceRes = await api("POST", "/api/technician/services", {
  body: { ...servicePayload, title: `Unapproved Repair ${stamp}` },
  cookie: tech.cookie,
});
const pendingServiceId = pendingServiceRes.data?.data?.id;

// --- 3. public detail gating (approved + available only) ---
const pendingDetail = await api("GET", `/api/services/${pendingServiceId}`);
check("unapproved service hidden", pendingDetail.status === 404, `status=${pendingDetail.status}`);

const approve = await api("PATCH", `/api/admin/services/${serviceId}`, {
  body: { status: "approved" },
  cookie: adminInfo.cookie,
});
check("admin approves service", approve.status === 200, `status=${approve.status}`);

const detail = await api("GET", `/api/services/${serviceId}`);
const publicService = detail.data?.data;
check(
  "approved service detail is public",
  detail.status === 200 && publicService?.title === servicePayload.title,
  `status=${detail.status} title=${publicService?.title}`,
);
check(
  "detail exposes technician identity",
  Boolean(publicService?.technicianEmail) || Boolean(publicService?.technicianName),
  `technicianEmail=${publicService?.technicianEmail} technicianName=${publicService?.technicianName}`,
);
check(
  "detail exposes price fields",
  typeof publicService?.basePrice === "number" || typeof publicService?.price === "number",
  `basePrice=${publicService?.basePrice} price=${publicService?.price}`,
);

const unapprovedBook = await api("POST", "/api/bookings", {
  body: validBody(pendingServiceId),
  cookie: cust.cookie,
});
check("unapproved service not bookable", unapprovedBook.status === 404, `status=${unapprovedBook.status}`);

// --- 4. request validation ---
const pastDate = await api("POST", "/api/bookings", {
  body: validBody(serviceId, { preferredDate: calendarDate(-1) }),
  cookie: cust.cookie,
});
check("past preferred date rejected", pastDate.status === 400, `status=${pastDate.status}`);

const shortProblem = await api("POST", "/api/bookings", {
  body: validBody(serviceId, { problemDescription: "broken" }),
  cookie: cust.cookie,
});
check("short problem description rejected", shortProblem.status === 400, `status=${shortProblem.status}`);

const badPhone = await api("POST", "/api/bookings", {
  body: validBody(serviceId, { customerPhone: "abc" }),
  cookie: cust.cookie,
});
check("invalid phone rejected", badPhone.status === 400, `status=${badPhone.status}`);

const shortAddr = await api("POST", "/api/bookings", {
  body: validBody(serviceId, { address: "1" }),
  cookie: cust.cookie,
});
check("short address rejected", shortAddr.status === 400, `status=${shortAddr.status}`);

const spoofed = await api("POST", "/api/bookings", {
  body: validBody(serviceId, {
    customerEmail: "spoof@example.com",
    customerName: "Spoofed",
    basePrice: 1,
    technicianEmail: "nobody@example.com",
    status: "completed",
  }),
  cookie: cust.cookie,
});
check(
  "identity/price/status spoofing ignored",
  spoofed.status === 201 &&
    spoofed.data?.data?.customerEmail === credentials.customer.email &&
    spoofed.data?.data?.status === "requested" &&
    typeof spoofed.data?.data?.basePrice === "number" &&
    spoofed.data?.data?.basePrice !== 1,
  `status=${spoofed.status} customerEmail=${spoofed.data?.data?.customerEmail} status=${spoofed.data?.data?.status} basePrice=${spoofed.data?.data?.basePrice}`,
);
const booking1 = spoofed.data?.data;

check(
  "new booking shape",
  booking1?.paymentStatus === "unpaid" &&
    booking1?.finalAmount === null &&
    booking1?.status === "requested" &&
    typeof booking1?._id === "string" &&
    typeof booking1?.technicianEmail === "string" &&
    booking1?.preferredDate === calendarDate(2),
  `status=${booking1?.status} payment=${booking1?.paymentStatus} final=${booking1?.finalAmount} preferredDate=${booking1?.preferredDate}`,
);

const dup = await api("POST", "/api/bookings", {
  body: validBody(serviceId),
  cookie: cust.cookie,
});
check(
  "duplicate active request blocked with exact message",
  dup.status === 409 &&
    dup.data?.error === "You already have an active request for this service.",
  `status=${dup.status} error=${dup.data?.error}`,
);

const noOriginRes = await fetch(`${BASE}/api/bookings/mine`, { headers: { Cookie: cust.cookie } });
check("missing Origin rejected", noOriginRes.status === 403, `status=${noOriginRes.status}`);

const anon = await api("GET", "/api/bookings/mine");
check("anonymous list rejected", anon.status === 401, `status=${anon.status}`);

const techBooking = await api("POST", "/api/bookings", {
  body: validBody(serviceId),
  cookie: tech.cookie,
});
check("technician cannot request a repair", techBooking.status === 403, `status=${techBooking.status}`);

// --- 5. scoped lists ---
const mine = await api("GET", "/api/bookings/mine", { cookie: cust.cookie });
check(
  "customer mine list",
  mine.status === 200 && (mine.data?.data ?? []).some((b) => b.id === booking1?.id),
  `status=${mine.status} count=${mine.data?.data?.length}`,
);

const assigned = await api("GET", "/api/bookings/assigned", { cookie: tech.cookie });
check(
  "technician assigned list",
  assigned.status === 200 && (assigned.data?.data ?? []).some((b) => b.id === booking1?.id),
  `status=${assigned.status} count=${assigned.data?.data?.length}`,
);

const otherTech = await api("GET", "/api/bookings/assigned", { cookie: tech2.cookie });
check(
  "other technician sees no foreign requests",
  otherTech.status === 200 && !(otherTech.data?.data ?? []).some((b) => b.id === booking1?.id),
  `status=${otherTech.status} count=${otherTech.data?.data?.length}`,
);

const tech2ForbiddenTransition = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "accepted" },
  cookie: tech2.cookie,
});
check(
  "other technician cannot transition someone else's request",
  tech2ForbiddenTransition.status === 404,
  `status=${tech2ForbiddenTransition.status}`,
);

const all = await api("GET", "/api/bookings", { cookie: adminInfo.cookie });
check(
  "admin all list",
  all.status === 200 && (all.data?.data ?? []).some((b) => b.id === booking1?.id),
  `status=${all.status} total=${all.data?.total}`,
);

const filtered = await api("GET", "/api/bookings", {
  cookie: adminInfo.cookie,
  query: { status: "requested" },
});
check(
  "admin status filter",
  filtered.status === 200 &&
    Array.isArray(filtered.data?.data) &&
    filtered.data.data.every((b) => b.status === "requested"),
  `status=${filtered.status} count=${filtered.data?.data?.length}`,
);

const badFilter = await api("GET", "/api/bookings", {
  cookie: adminInfo.cookie,
  query: { status: "bogus" },
});
check("admin bad filter rejected", badFilter.status === 400, `status=${badFilter.status}`);

const custAll = await api("GET", "/api/bookings", { cookie: cust.cookie });
check("customer denied admin list", custAll.status === 403, `status=${custAll.status}`);

const techAll = await api("GET", "/api/bookings", { cookie: tech.cookie });
check("technician denied admin list", techAll.status === 403, `status=${techAll.status}`);

// --- 6. strict transition rules ---
const customerAccept = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "accepted" },
  cookie: cust.cookie,
});
check("customer cannot accept own booking", customerAccept.status === 409, `status=${customerAccept.status}`);

const jumpComplete = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "completed" },
  cookie: tech.cookie,
});
check("requested cannot jump to completed", jumpComplete.status === 409, `status=${jumpComplete.status}`);

const badStatus = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "bogus" },
  cookie: tech.cookie,
});
check("invalid status rejected", badStatus.status === 400, `status=${badStatus.status}`);

const paidAttempt = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "paid" },
  cookie: tech.cookie,
});
check("status 'paid' rejected (payment is not a status)", paidAttempt.status === 400, `status=${paidAttempt.status}`);

const paymentStatusAttempt = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "completed", finalAmount: 79.5, paymentStatus: "paid" },
  cookie: tech.cookie,
});
check(
  "client-supplied paymentStatus rejected",
  paymentStatusAttempt.status === 400,
  `status=${paymentStatusAttempt.status}`,
);

const adminOverride = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "accepted" },
  cookie: adminInfo.cookie,
});
check("admin transition denied", adminOverride.status === 403, `status=${adminOverride.status}`);

const strangerPatch = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "accepted" },
  cookie: bystander.cookie,
});
check("foreign technician cannot transition", strangerPatch.status === 404, `status=${strangerPatch.status}`);

const strangerRead = await api("GET", `/api/bookings/${booking1?.id}`, { cookie: bystander.cookie });
check("stranger cannot read booking", strangerRead.status === 404, `status=${strangerRead.status}`);

const missingBooking = await api("GET", "/api/bookings/deadbeefdeadbeefdeadbeef", {
  cookie: cust.cookie,
});
check("missing booking 404", missingBooking.status === 404, `status=${missingBooking.status}`);

// --- 7. service delete blocked while a booking is active ---
const deleteBlocked = await api("DELETE", `/api/technician/services/${serviceId}`, {
  cookie: tech.cookie,
});
check("delete blocked by active booking", deleteBlocked.status === 409, `status=${deleteBlocked.status}`);

// --- 8. happy path: accept -> in-progress -> completed ---
const accept = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "accepted" },
  cookie: tech.cookie,
});
check(
  "technician accepts",
  accept.status === 200 && accept.data?.data?.status === "accepted",
  `status=${accept.status} body=${accept.data?.data?.status}`,
);

const acceptAgain = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "accepted" },
  cookie: tech.cookie,
});
check("repeated accept rejected", acceptAgain.status === 409, `status=${acceptAgain.status}`);

const cancelAfterAccept = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "cancelled" },
  cookie: cust.cookie,
});
check("customer cannot cancel accepted booking", cancelAfterAccept.status === 409, `status=${cancelAfterAccept.status}`);

const techCancel = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "cancelled" },
  cookie: tech.cookie,
});
check("technician cannot cancel", techCancel.status === 409, `status=${techCancel.status}`);

const completeEarly = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "completed", finalAmount: 79.5 },
  cookie: tech.cookie,
});
check("accepted cannot jump to completed", completeEarly.status === 409, `status=${completeEarly.status}`);

const start = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "in-progress" },
  cookie: tech.cookie,
});
check(
  "technician starts work",
  start.status === 200 && start.data?.data?.status === "in-progress",
  `status=${start.status}`,
);

const completeNoAmount = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "completed" },
  cookie: tech.cookie,
});
check(
  "completion requires final amount",
  completeNoAmount.status === 400,
  `status=${completeNoAmount.status} error=${completeNoAmount.data?.error}`,
);

const completeZero = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "completed", finalAmount: 0 },
  cookie: tech.cookie,
});
check("final amount must be > 0", completeZero.status === 400, `status=${completeZero.status}`);

const complete = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "completed", finalAmount: 89.75 },
  cookie: tech.cookie,
});
check(
  "technician completes with final amount",
  complete.status === 200 &&
    complete.data?.data?.status === "completed" &&
    complete.data?.data?.finalAmount === 89.75 &&
    complete.data?.data?.paymentStatus === "unpaid",
  `status=${complete.status} final=${complete.data?.data?.finalAmount} payment=${complete.data?.data?.paymentStatus}`,
);

const completeAgain = await api("PATCH", `/api/bookings/${booking1?.id}/status`, {
  body: { status: "completed", finalAmount: 10 },
  cookie: tech.cookie,
});
check("terminal state protected", completeAgain.status === 409, `status=${completeAgain.status}`);

// --- 9. reject + cancel paths (need fresh active bookings) ---
const book2 = await api("POST", "/api/bookings", {
  body: validBody(serviceId, { address: "99 Another Road, Suite 12" }),
  cookie: cust.cookie,
});
const booking2 = book2.data?.data;
check("second booking created", book2.status === 201, `status=${book2.status}`);

const reject = await api("PATCH", `/api/bookings/${booking2?.id}/status`, {
  body: { status: "rejected" },
  cookie: tech.cookie,
});
check(
  "technician rejects",
  reject.status === 200 && reject.data?.data?.status === "rejected",
  `status=${reject.status}`,
);

const book3 = await api("POST", "/api/bookings", {
  body: validBody(serviceId, { address: "7 Cancel Lane, Floor 3" }),
  cookie: cust.cookie,
});
const booking3 = book3.data?.data;
check("third booking created", book3.status === 201, `status=${book3.status}`);

const cancel = await api("PATCH", `/api/bookings/${booking3?.id}/status`, {
  body: { status: "cancelled" },
  cookie: cust.cookie,
});
check(
  "customer cancels requested booking",
  cancel.status === 200 && cancel.data?.data?.status === "cancelled",
  `status=${cancel.status}`,
);

const cancelAgain = await api("PATCH", `/api/bookings/${booking3?.id}/status`, {
  body: { status: "accepted" },
  cookie: tech.cookie,
});
check("cancelled stays terminal", cancelAgain.status === 409, `status=${cancelAgain.status}`);

// Terminal (rejected) bookings no longer count as active duplicates.
const book4 = await api("POST", "/api/bookings", {
  body: validBody(serviceId, { address: "12 Test Street, Apt 4" }),
  cookie: cust.cookie,
});
check("re-request allowed after terminal status", book4.status === 201, `status=${book4.status}`);
if (book4.status === 201) {
  const cleanup = await api("PATCH", `/api/bookings/${book4.data?.data?.id}/status`, {
    body: { status: "cancelled" },
    cookie: cust.cookie,
  });
  check("cleanup cancel", cleanup.status === 200, `status=${cleanup.status}`);
}

// --- 10. profile + admin accounts still behave ---
const profile = await api("GET", "/api/dashboard/profile", { cookie: cust.cookie });
check(
  "profile read",
  profile.status === 200 && profile.data?.data?.email === credentials.customer.email,
  `status=${profile.status}`,
);

const accounts = await api("GET", "/api/admin/accounts", { cookie: adminInfo.cookie });
check(
  "admin accounts list",
  accounts.status === 200 && Array.isArray(accounts.data?.data),
  `status=${accounts.status} count=${accounts.data?.data?.length}`,
);

const accountsDenied = await api("GET", "/api/admin/accounts", { cookie: cust.cookie });
check("customer denied accounts", accountsDenied.status === 403, `status=${accountsDenied.status}`);

// --- 11. service delete now that no booking is active ---
const deleteOk = await api("DELETE", `/api/technician/services/${serviceId}`, { cookie: tech.cookie });
check(
  "service delete",
  deleteOk.status === 200 && deleteOk.data?.data?.deleted === true,
  `status=${deleteOk.status}`,
);

const gone = await api("GET", `/api/services/${serviceId}`);
check("deleted service gone", gone.status === 404, `status=${gone.status}`);

// Cleanup: remove the unapproved test listing.
if (pendingServiceId) {
  await api("DELETE", `/api/technician/services/${pendingServiceId}`, { cookie: tech.cookie });
}

// --- 12. public service list still works ---
const list = await api("GET", "/api/services");
check("public services list", list.status === 200, `status=${list.status}`);

await client.close();

console.log(results.join("\n"));
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
