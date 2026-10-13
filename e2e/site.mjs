// A tiny shop to drive: product page, cart, checkout with a card field and a Place order button.
// The product heading is set in a web font the shop serves, for inspect_element.
import { readFileSync } from 'node:fs';
import http from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>@font-face{font-family:'Inter Variable';src:url(/inter.woff2) format('woff2')} h1{font-family:'Inter Variable',sans-serif}
body{font:16px sans-serif;margin:40px} button,a{font-size:16px} .row{margin:12px 0}</style></head><body>${body}</body></html>`;

const shop = page('Coffee shop — Ethiopian beans', `
<h1>Ethiopian Yirgacheffe</h1>
<a href="/cart" id="cartlink">Cart (<span id="count">0</span>)</a>
<fieldset><legend>Size</legend>
  <label><input type="radio" name="size" value="250g" checked> 250 g</label>
  <label><input type="radio" name="size" value="1kg"> 1 kg</label>
</fieldset>
<div class="row"><button type="button" id="add">Add to cart</button> <span id="added"></span></div>
 <div class="row"><button type="button" id="feedback" onclick="this.textContent='Feedback sent'">Send feedback</button></div>
<div class="row"><div id="fancy" style="cursor:pointer;display:inline-block;padding:4px;border:1px solid #888">Gift wrap</div></div>
<script>
  const cart = () => JSON.parse(localStorage.cart || '[]');
  const show = () => document.getElementById('count').textContent = cart().length;
  show();
  document.getElementById('add').addEventListener('click', () => {
    const size = document.querySelector('input[name=size]:checked').value;
    localStorage.cart = JSON.stringify([...cart(), 'yirgacheffe-' + size]);
    show();
    document.getElementById('added').textContent = 'Added ' + size + '!';
  });
</script>`);

const cart = page('Your cart', `<h1>Cart</h1><ul id="items"></ul><a href="/checkout">Proceed to checkout</a>
<script>for (const i of JSON.parse(localStorage.cart || '[]')) { const li = document.createElement('li'); li.textContent = i; items.append(li); }</script>`);

const checkout = page('Checkout', `<h1>Checkout</h1>
<form id="f" onsubmit="event.preventDefault(); document.title='ORDER PLACED'">
  <div class="row"><label>Email <input name="email" type="email" autocomplete="email"></label></div>
  <div class="row"><label>Card number <input name="cardnumber" autocomplete="cc-number"></label></div>
  <div class="row"><button type="submit">Place order</button></div>
</form>
<p>Model: <span id="model"></span></p>
<script>
  // Like a framework's controlled input: the model only changes on input events.
  document.querySelector('input[name=email]').addEventListener('input', (e) => { model.textContent = e.target.value; });
</script>`);

const font = readFileSync(new URL('../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', import.meta.url));

export function startSite() {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/inter.woff2') {
      res.writeHead(200, { 'content-type': 'font/woff2' });
      return res.end(font);
    }
    const body = path === '/cart' ? cart : path === '/checkout' ? checkout : shop;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
