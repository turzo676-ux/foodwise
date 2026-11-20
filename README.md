# 🥗 FoodWise — Smart Food Lifecycle & Waste Management System

Node.js + Express + SQLite backend, vanilla JS frontend (served from `/public`).

## Run locally
```bash
npm install
cp .env.example .env      # optional: set JWT_SECRET, ADMIN_USER, ADMIN_PASS
node server.js            # http://localhost:3000
```
Default login (first run): `admin` / `admin123` — change via `ADMIN_USER` / `ADMIN_PASS` env vars before first run.
After login, press **Demo data load** on the Alerts tab to try every feature.

## REST API (all except login need `Authorization: Bearer <token>`)
| Feature | API | Purpose |
|---|---|---|
| Login | POST `/api/auth/login` | Get JWT token |
| Food Entry | POST `/api/foods` | Add/update food (upsert by name) |
| Food List | GET `/api/foods` (`?barcode=`) | List foods / barcode lookup |
| Inventory | GET `/api/inventory` | Stock batches, FEFO ordered |
| Stock Update | PUT `/api/batches/:id` | Update quantity/expiry (DELETE removes batch) |
| Expiry | GET `/api/expiry-alerts?days=3` | Expired, expiring soon, low stock |
| Consumption | POST `/api/consumptions` | `{batch_id, qty}` or `{food_id, qty}` (auto FEFO) |
| Waste | POST `/api/waste` | `{batch_id, qty?, reason?}` |
| Analytics | GET `/api/waste/analytics` | Total loss, by food, by month, log |
| Purchase | POST `/api/purchases` | `{food_id, qty, unit_price, expiry_date}` creates a batch |
| Donation | POST `/api/donations` | `{batch_id, qty?, organization?}` |

Extra: `GET /api/consumptions`, `GET /api/purchases`, `GET /api/donations`, `POST /api/seed`.

## Database tables
users, foods, purchases, batches, consumptions, waste, donations.

## Deploy (Render / Railway / VPS)
- Build: `npm install` · Start: `node server.js`
- Env vars: `JWT_SECRET` (long random), `ADMIN_USER`, `ADMIN_PASS`, `DB_FILE`
- SQLite is a file, so attach a **persistent disk/volume** and point `DB_FILE` to it (e.g. `/data/foodwise.db`), otherwise data is lost on redeploy.
- Camera barcode scan needs HTTPS (Render/Railway provide it).
