# Dumpling Lab ordering server

## Run locally

Install Node.js 22.5 or newer. Configure the first administrator in PowerShell, then start the site:

```powershell
$env:BOOTSTRAP_ADMIN_EMAIL = 'owner@example.com'
$env:BOOTSTRAP_ADMIN_PASSWORD = 'replace-with-your-own-unique-password'
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$secretBytes = New-Object byte[] 48
$rng.GetBytes($secretBytes)
$env:JWT_SECRET = [Convert]::ToBase64String($secretBytes)
$rng.Dispose()
npm start
```

Open <http://localhost:4173>. The first launch creates `data/orders.sqlite`, a private signing-key file when `JWT_SECRET` is not set, and the initial administrator account. Keep `data/` private and persistent; it is excluded from Git and its database/key files are never served. In production, configure `JWT_SECRET` as a deployment secret and use HTTPS.

Restaurant owners sign in using the configured email and password. The bootstrap credentials create an admin only when that email does not already exist; admin rights are never offered through public signup. Public customer signup creates a `customer` account with read-only menu access. Sessions use signed JWTs that expire after eight hours and are kept in the browser's session storage.

## Create a customer account

Open the site through `http://localhost:4173`, click **Sign in**, enter an email and a password of at least 12 characters, then click **Create customer account**. Customer accounts can browse the menu and place orders; they cannot edit the menu, offers, or restaurant orders.

If signup responds with **“Staff access required”**, the browser is connected to an older server process. Stop the server in the terminal where it is running with **Ctrl+C**, start it again from this project folder with `npm start`, then refresh the page. The updated `/api/auth/signup` endpoint is public; only the admin operations require admin authentication. Do not enter the old staff token to create a customer account.

The menu categories are Dumplings, Noodles, Sauces, and Beverages. Customers choose Steamed, Pan-fried, or Crispy skirt for each dumpling; all three preparations use the listed price, and the choice is saved with the order. Menu, categories, styles, and photos are stored server-side in SQLite and `data/uploads/`. Menu-edit, category-edit, offer-edit, order-management, and photo-upload API operations require an admin JWT. `GET /api/offers` lists active offers publicly; `GET /api/offers?all=true` lists all offers to admins. Offer creation and editing use `POST /api/offers`, `PUT /api/offers/:id`, and `DELETE /api/offers/:id`, all admin-only. Uploaded image contents are checked for JPEG, PNG, or WebP signatures and limited to 2.5 MB. Public menu reads and customer order placement do not require an account. On startup, older menu categories are mapped into the new four-category set without deleting the menu items.

The landing-page hero dumplings, bamboo basket, and steam are drawn as inline vector artwork and animated with CSS; the motion automatically respects the visitor's reduced-motion preference.

The site must be opened through this server. Orders are saved in SQLite on the server, not in a customer's browser. The staff order book refreshes every 20 seconds. Update an order's status there; earnings include all orders except those marked Cancelled.

## Excel export

In **Orders**, choose **Export CSV**. Excel opens the downloaded CSV, including order number, time, customer/contact details, item and quantity, payment method, subtotal, status, and notification delivery. The export uses a UTF-8 BOM and protects spreadsheet cells from formula injection.

## Restaurant notifications

Orders immediately appear in the database-backed staff inbox. To also push each new order to a restaurant system that accepts a JSON webhook, set `RESTAURANT_WEBHOOK_URL` before starting the server. It receives a `POST` with `{ "event": "new_order", "order": { ... } }`. A successful webhook is shown on the order; failed webhook delivery leaves the order safely saved in the inbox.

PowerShell example:

```powershell
$env:RESTAURANT_WEBHOOK_URL = 'https://your-order-system.example/webhook'
npm start
```

For deployment, set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, and `JWT_SECRET` securely, plus `RESTAURANT_WEBHOOK_URL` to your restaurant's actual receiving endpoint. Use a host with persistent disk storage for `data/orders.sqlite` and `data/uploads/`; ephemeral server filesystems will lose orders and uploaded photos on restart or redeploy. Put the server behind HTTPS before accepting real customer details. Back up the `data/` directory regularly.

## Notes

- SQLite is built into Node.js 22.5+ through `node:sqlite`.
- Order items and prices are saved as an order-time snapshot.
- Customer signup is read-only. Admin accounts are created through the bootstrap environment settings, never through public signup.
- Menu categories, dishes, offers, and uploaded photos are stored on the server and guarded by admin authorization.
- The provided logo attachment was not available as a file in the workspace, so `assets/dumpling-lab-logo.svg` is a vector recreation of its red circular seal design.