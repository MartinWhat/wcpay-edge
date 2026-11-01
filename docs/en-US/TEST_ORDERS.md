# Admin test orders

Test orders let administrators preview checkout and exercise order status flows
without receiving money or notifying a merchant.

## Enable

Deploy the application with migration `0013_nasty_loners.sql` applied. On
Cloudflare Workers Builds, the configured build applies pending D1 migrations;
the Wrangler `predeploy` flow does the same. Then sign in to `/admin`, open
**System settings → Order configuration**, enable **Test orders**, and save.
The setting is disabled by default.

## Create and simulate

Open **Payment operations → Orders** and choose **Create test order**. Enter a
fiat amount and currency, then create the order. Open its checkout link to
preview the payer page. From the order row's actions, choose **Simulate status**
to exercise valid order transitions.

Test orders are marked in the order list, have no selectable payment method,
reject transaction and payment-review submissions, and do not appear in
dashboard order metrics. Status simulation is available only for test orders
and does not send merchant callbacks. Creating a test order requires
`orders:create`; simulating its status requires `orders:update`.

Disable **Test orders** in Order configuration when testing is complete.
