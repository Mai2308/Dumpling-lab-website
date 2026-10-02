# Dumpling Lab ordering server

## Run locally

Install Node.js 22.5 or newer, then run `npm start` in this folder and open <http://localhost:4173>. The first launch creates `data/orders.sqlite` and a private `data/admin-token` file. Copy the staff access token printed in the server console, choose **Orders** on the site, and enter that token. To retrieve the token later in PowerShell, run `Get-Content data/admin-token`. Keep both files private; `data/` is excluded from Git and is never served by the website.

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

For deployment, set `ADMIN_TOKEN` to a long random secret and `RESTAURANT_WEBHOOK_URL` to your restaurant's actual receiving endpoint. Use a host with persistent disk storage for `data/orders.sqlite`; ephemeral server filesystems will lose orders on restart or redeploy. Put the server behind HTTPS before accepting real customer details. Back up the `data/` directory regularly.

## Notes

- SQLite is built into Node.js 22.5+ through `node:sqlite`.
- Order items and prices are saved as an order-time snapshot.
- Menu editing is still browser-local; this update makes order records shared and server-persistent.
- The provided logo attachment was not available as a file in the workspace, so `assets/dumpling-lab-logo.svg` is a vector recreation of its red circular seal design.