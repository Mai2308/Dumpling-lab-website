const STORAGE_KEYS = { menu: 'dumpling-lab-menu-v1', staffToken: 'dumpling-lab-staff-token' };
const starterCategories = ['All', 'Steamed', 'Pan-fried', 'Little extras'];
const starterItems = [
  { id: 'item-1', name: 'Ginger cloud', category: 'Steamed', price: 185, description: 'Chicken, fresh ginger, and a little spring onion tucked into soft, silky wrappers.', image: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?auto=format&fit=crop&w=900&q=85', tag: 'HOUSE FAVOURITE' },
  { id: 'item-2', name: 'Golden crunch', category: 'Pan-fried', price: 210, description: 'Crispy-bottomed parcels, juicy chicken, and sesame soy for dipping.', image: 'https://images.unsplash.com/photo-1562802378-063ec186a863?auto=format&fit=crop&w=900&q=85', tag: 'CRISPY LITTLE THING' },
  { id: 'item-3', name: 'Mushroom moon', category: 'Steamed', price: 195, description: 'Earthy shiitake, cabbage, and garlic chives. A lovely little plant-based parcel.', image: 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=900&q=85', tag: 'PLANT-BASED' },
  { id: 'item-4', name: 'Chilli oil crush', category: 'Pan-fried', price: 220, description: 'Pork, a slow-building chilli warmth, and a crackly golden skirt.', image: 'https://images.unsplash.com/photo-1562802378-063ec186a863?auto=format&fit=crop&w=900&q=85', tag: 'A LITTLE HEAT' },
  { id: 'item-5', name: 'The dipping trio', category: 'Little extras', price: 75, description: 'House soy, ginger vinegar, and the chilli oil that started it all.', image: 'https://images.unsplash.com/photo-1472476443507-c7a5948772fc?auto=format&fit=crop&w=900&q=85', tag: 'THREE IS THE MAGIC NUMBER' },
  { id: 'item-6', name: 'Sesame clouds', category: 'Little extras', price: 125, description: 'Warm, pillowy sesame buns with a molten sweet black sesame centre.', image: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=900&q=85', tag: 'SOMETHING SWEET' }
];
const readJSON = (key, fallback) => {
  try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
  catch { return fallback; }
};
const savedMenu = readJSON(STORAGE_KEYS.menu, null);
const state = {
  categories: savedMenu?.categories ?? starterCategories.slice(1),
  items: savedMenu?.items ?? starterItems,
  selectedCategory: 'All',
  cart: {},
  managing: false,
  orders: [],
  orderPoll: null
};
const money = value => `EGP ${Number(value).toLocaleString('en-EG')}`;
const byId = id => document.getElementById(id);
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fallbackImage = 'https://images.unsplash.com/photo-1563245372-f21724e3856d?auto=format&fit=crop&w=900&q=75';

function saveMenu() {
  localStorage.setItem(STORAGE_KEYS.menu, JSON.stringify({ categories: state.categories, items: state.items }));
}

function renderCategories() {
  const tabs = byId('category-tabs');
  tabs.innerHTML = ['All', ...state.categories].map(category => `<button class="category-tab ${state.selectedCategory === category ? 'active' : ''}" data-category="${escapeHTML(category)}" type="button">${escapeHTML(category)}${state.managing && category !== 'All' ? `<span class="manage-cat" role="button" tabindex="0" aria-label="Remove ${escapeHTML(category)} category" data-remove-category="${escapeHTML(category)}">×</span>` : ''}</button>`).join('');
  tabs.querySelectorAll('.category-tab').forEach(button => button.addEventListener('click', event => {
    if (event.target.closest('[data-remove-category]')) return;
    state.selectedCategory = button.dataset.category;
    renderMenu();
  }));
  tabs.querySelectorAll('[data-remove-category]').forEach(button => {
    const remove = event => { event.stopPropagation(); removeCategory(button.dataset.removeCategory); };
    button.addEventListener('click', remove);
    button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') remove(event); });
  });
  byId('add-category').hidden = !state.managing;
}

function renderMenu() {
  renderCategories();
  const visibleItems = state.items.filter(item => state.selectedCategory === 'All' || item.category === state.selectedCategory);
  byId('menu-count').textContent = `${visibleItems.length} ${visibleItems.length === 1 ? 'little lovely' : 'little lovelies'}`;
  byId('menu-empty').hidden = visibleItems.length > 0;
  byId('product-grid').innerHTML = visibleItems.map(item => `<article class="product-card"><div class="product-image-wrap"><img class="product-image" src="${escapeHTML(item.image || fallbackImage)}" alt="${escapeHTML(item.name)} dumplings" loading="lazy"><span class="product-tag">${escapeHTML(item.tag || item.category)}</span>${state.managing ? `<div class="card-manage"><button type="button" data-edit="${escapeHTML(item.id)}" aria-label="Edit ${escapeHTML(item.name)}" title="Edit dish">✎</button><button type="button" data-delete="${escapeHTML(item.id)}" aria-label="Remove ${escapeHTML(item.name)}" title="Remove dish">×</button></div>` : ''}</div><div class="product-info"><div class="product-title-row"><h3 class="product-title">${escapeHTML(item.name)}</h3><span class="product-price">${money(item.price)}</span></div><p class="product-description">${escapeHTML(item.description || '')}</p><div class="product-bottom"><span class="product-category">${escapeHTML(item.category)}</span><button class="add-to-bag" type="button" data-add="${escapeHTML(item.id)}" aria-label="Add ${escapeHTML(item.name)} to bag">+</button></div></div></article>`).join('');
  byId('product-grid').querySelectorAll('.product-image').forEach(image => image.addEventListener('error', () => { if (image.src !== fallbackImage) image.src = fallbackImage; }, { once: true }));
  byId('product-grid').querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => addToCart(button.dataset.add)));
  byId('product-grid').querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openItemDialog(button.dataset.edit)));
  byId('product-grid').querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => removeItem(button.dataset.delete)));
}

function renderCart() {
  const entries = Object.entries(state.cart).filter(([, quantity]) => quantity > 0);
  const count = entries.reduce((total, [, quantity]) => total + quantity, 0);
  const subtotal = entries.reduce((total, [id, quantity]) => total + (state.items.find(item => item.id === id)?.price ?? 0) * quantity, 0);
  byId('cart-count').textContent = count;
  byId('drawer-count').textContent = `(${count})`;
  byId('cart-subtotal').textContent = money(subtotal);
  byId('checkout-total').textContent = money(subtotal);
  byId('cart-empty').hidden = count > 0;
  byId('cart-summary').hidden = count === 0;
  byId('cart-lines').innerHTML = entries.map(([id, quantity]) => {
    const item = state.items.find(entry => entry.id === id);
    if (!item) return '';
    return `<article class="cart-line"><img src="${escapeHTML(item.image || fallbackImage)}" alt=""><div><h3>${escapeHTML(item.name)}</h3><p>${money(item.price)}</p><div class="quantity-controls"><button type="button" data-quantity="${escapeHTML(id)}" data-delta="-1" aria-label="Remove one ${escapeHTML(item.name)}">−</button><span>${quantity}</span><button type="button" data-quantity="${escapeHTML(id)}" data-delta="1" aria-label="Add one ${escapeHTML(item.name)}">+</button></div></div><span class="line-total">${money(item.price * quantity)}</span></article>`;
  }).join('');
  byId('cart-lines').querySelectorAll('[data-quantity]').forEach(button => button.addEventListener('click', () => addToCart(button.dataset.quantity, Number(button.dataset.delta))));
}

function addToCart(id, delta = 1) {
  state.cart[id] = Math.max(0, (state.cart[id] || 0) + delta);
  if (!state.cart[id]) delete state.cart[id];
  renderCart();
  if (delta > 0) showToast('A little something added to your bag.');
}

function setDrawer(open) {
  byId('cart-drawer').classList.toggle('open', open);
  byId('cart-drawer').setAttribute('aria-hidden', String(!open));
  byId('drawer-scrim').hidden = !open;
  document.body.classList.toggle('drawer-open', open);
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2300);
}

function setManaging(enabled) {
  state.managing = enabled;
  document.body.classList.toggle('manage-mode', enabled);
  byId('manage-label').textContent = enabled ? 'Done' : 'Manage';
  byId('manage-toggle').setAttribute('aria-pressed', String(enabled));
  byId('add-item').hidden = !enabled;
  renderMenu();
  showToast(enabled ? 'Menu management is on.' : 'Menu changes are saved on this device.');
}

function removeCategory(category) {
  if (!confirm(`Remove “${category}” and all dishes in it?`)) return;
  state.categories = state.categories.filter(entry => entry !== category);
  const removed = state.items.filter(item => item.category === category).map(item => item.id);
  state.items = state.items.filter(item => item.category !== category);
  removed.forEach(id => delete state.cart[id]);
  state.selectedCategory = 'All';
  saveMenu(); renderMenu(); renderCart();
}

function removeItem(id) {
  const item = state.items.find(entry => entry.id === id);
  if (!item || !confirm(`Remove “${item.name}” from the menu?`)) return;
  state.items = state.items.filter(entry => entry.id !== id);
  delete state.cart[id];
  saveMenu(); renderMenu(); renderCart();
  showToast('Dish removed from the menu.');
}

function openItemDialog(id = null) {
  if (!state.categories.length) { showToast('Add a category before adding a dish.'); return; }
  const form = byId('item-form');
  const item = state.items.find(entry => entry.id === id);
  form.reset();
  form.elements.id.value = item?.id ?? '';
  form.elements.name.value = item?.name ?? '';
  form.elements.category.innerHTML = state.categories.map(category => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join('');
  form.elements.category.value = item?.category ?? state.categories[0];
  form.elements.price.value = item?.price ?? '';
  form.elements.description.value = item?.description ?? '';
  form.elements.image.value = item?.image?.startsWith('data:') ? '' : item?.image ?? '';
  form.elements.imageFile.value = '';
  byId('item-dialog-title').textContent = item ? 'Edit this dish' : 'Add a dish';
  setImagePreview(item?.image || '');
  byId('item-dialog').showModal();
}

function setImagePreview(source) {
  const preview = byId('image-preview');
  preview.hidden = !source;
  if (source) preview.querySelector('img').src = source;
}

byId('item-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value || `item-${crypto.randomUUID()}`;
  const previous = state.items.find(item => item.id === id);
  const file = form.elements.imageFile.files[0];
  let image = form.elements.image.value.trim() || previous?.image || fallbackImage;
  if (file) image = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
  }).catch(() => null);
  if (!image) { showToast('That photo could not be loaded. Please try another.'); return; }
  const item = { id, name: form.elements.name.value.trim(), category: form.elements.category.value, price: Number(form.elements.price.value), description: form.elements.description.value.trim(), image, tag: previous?.tag || 'FOLDED FRESH' };
  state.items = previous ? state.items.map(entry => entry.id === id ? item : entry) : [...state.items, item];
  saveMenu(); byId('item-dialog').close(); renderMenu(); renderCart();
  showToast(previous ? 'Your dish has been updated.' : 'A new dish joins the menu.');
});

byId('add-category').addEventListener('click', () => {
  const category = prompt('What should this category be called?');
  if (!category?.trim()) return;
  const clean = category.trim().slice(0, 35);
  if (state.categories.some(entry => entry.toLowerCase() === clean.toLowerCase())) { showToast('That category already exists.'); return; }
  state.categories.push(clean); state.selectedCategory = clean; saveMenu(); renderMenu();
});
byId('add-item').addEventListener('click', () => openItemDialog());

byId('checkout-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const entries = Object.entries(state.cart).filter(([, quantity]) => quantity > 0);
  if (!entries.length) return;
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.firstChild.textContent = 'Sending your order ';
  try {
    const orderPayload = {
      customer: form.elements.customer.value.trim(),
      phone: form.elements.phone.value.trim(),
      address: form.elements.address.value.trim(),
      payment: form.elements.payment.value,
      items: entries.map(([id, quantity]) => {
        const item = state.items.find(entry => entry.id === id);
        return { name: item.name, category: item.category, quantity, unitPrice: Number(item.price) };
      })
    };
    const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderPayload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Your order could not be sent. Please try again.');
    const order = result.order;
    byId('order-confirmation').textContent = `Order ${order.id} is in the kitchen for ${order.customer}. We’ll call ${order.phone} to confirm the details and delivery fee.`;
    byId('instapay-details').hidden = order.payment !== 'InstaPay';
    state.cart = {};
    form.reset(); renderCart();
    byId('checkout-dialog').close(); setDrawer(false); byId('success-dialog').showModal();
  } catch (error) {
    showToast(error.message.includes('Failed to fetch') ? 'The order server is unavailable. Please try again shortly.' : error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.firstChild.textContent = 'Place my order ';
  }
});

async function loadOrders(token = sessionStorage.getItem(STORAGE_KEYS.staffToken)) {
  const response = await fetch('/api/orders', { headers: { Authorization: `Bearer ${token}` } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not load orders.');
  state.orders = result.orders;
  sessionStorage.setItem(STORAGE_KEYS.staffToken, token);
  byId('staff-auth-form').hidden = true;
  byId('orders-content').hidden = false;
  byId('staff-auth-message').textContent = '';
  renderOrders();
}

function renderOrders() {
  const count = state.orders.length;
  const earnings = state.orders.reduce((total, order) => total + (order.status === 'Cancelled' ? 0 : order.subtotal), 0);
  const awaiting = state.orders.filter(order => order.status === 'New').length;
  byId('order-stat-count').textContent = count;
  byId('order-stat-earnings').textContent = money(earnings);
  byId('order-stat-new').textContent = awaiting;
  byId('orders-last-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · refreshes every 20 seconds`;
  byId('orders-list').innerHTML = count ? state.orders.map(order => `<article class="order-card"><div class="order-card-head"><div><span class="order-id">${escapeHTML(order.id)}</span><time>${new Date(order.createdAt).toLocaleString()}</time></div><strong>${money(order.subtotal)}</strong></div><div class="order-customer"><strong>${escapeHTML(order.customer)}</strong><a href="tel:${escapeHTML(order.phone)}">${escapeHTML(order.phone)}</a><span>${escapeHTML(order.address)}</span></div><div class="order-items">${order.items.map(item => `<span>${item.quantity} × ${escapeHTML(item.name)}</span>`).join('')}<span class="order-payment">${escapeHTML(order.payment)}</span></div><div class="order-card-foot"><span class="notification-state">${escapeHTML(order.notification_status)}</span><label>Status<select data-order-status="${escapeHTML(order.id)}">${['New', 'Preparing', 'Out for delivery', 'Completed', 'Cancelled'].map(status => `<option${status === order.status ? ' selected' : ''}>${status}</option>`).join('')}</select></label></div></article>`).join('') : '<div class="orders-empty">No orders yet. New customer orders will appear here.</div>';
  byId('orders-list').querySelectorAll('[data-order-status]').forEach(select => select.addEventListener('change', async () => {
    const token = sessionStorage.getItem(STORAGE_KEYS.staffToken);
    select.disabled = true;
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(select.dataset.orderStatus)}/status`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: select.value }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not update order status.');
      state.orders = state.orders.map(order => order.id === result.order.id ? result.order : order);
      renderOrders();
    } catch (error) { showToast(error.message); select.disabled = false; }
  }));
}

byId('staff-auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const token = form.elements.token.value.trim();
  byId('staff-auth-message').textContent = 'Checking staff access…';
  try { await loadOrders(token); }
  catch (error) { byId('staff-auth-message').textContent = error.message; }
});

byId('orders-export').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/orders.csv', { headers: { Authorization: `Bearer ${sessionStorage.getItem(STORAGE_KEYS.staffToken)}` } });
    if (!response.ok) throw new Error('Could not export orders. Sign in again.');
    const blob = await response.blob();
    const download = document.createElement('a');
    download.href = URL.createObjectURL(blob);
    download.download = 'dumpling-lab-orders.csv';
    download.click();
    URL.revokeObjectURL(download.href);
  } catch (error) { showToast(error.message); }
});

byId('orders-refresh').addEventListener('click', () => loadOrders().catch(error => showToast(error.message)));
byId('orders-open').addEventListener('click', async () => {
  byId('orders-dialog').showModal();
  const token = sessionStorage.getItem(STORAGE_KEYS.staffToken);
  if (token) {
    try { await loadOrders(token); }
    catch { sessionStorage.removeItem(STORAGE_KEYS.staffToken); byId('orders-content').hidden = true; byId('staff-auth-form').hidden = false; }
  }
  clearInterval(state.orderPoll);
  state.orderPoll = setInterval(() => {
    if (byId('orders-dialog').open && sessionStorage.getItem(STORAGE_KEYS.staffToken)) loadOrders().catch(error => showToast(error.message));
  }, 20_000);
});
byId('orders-close').addEventListener('click', () => { byId('orders-dialog').close(); clearInterval(state.orderPoll); });

byId('manage-toggle').addEventListener('click', () => setManaging(!state.managing));
byId('cart-open').addEventListener('click', () => { renderCart(); setDrawer(true); });
byId('cart-close').addEventListener('click', () => setDrawer(false));
byId('drawer-scrim').addEventListener('click', () => setDrawer(false));
byId('checkout-open').addEventListener('click', () => { byId('checkout-dialog').showModal(); });
byId('success-close').addEventListener('click', () => byId('success-dialog').close());
byId('empty-menu-link').addEventListener('click', () => setDrawer(false));
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
byId('item-form').elements.image.addEventListener('input', event => setImagePreview(event.target.value));
byId('item-form').elements.imageFile.addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2_500_000) { event.target.value = ''; showToast('Please choose an image under 2.5 MB.'); return; }
  setImagePreview(URL.createObjectURL(file));
});
byId('clear-image').addEventListener('click', () => { byId('item-form').elements.image.value = ''; byId('item-form').elements.imageFile.value = ''; setImagePreview(''); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && byId('cart-drawer').classList.contains('open')) setDrawer(false); });

renderMenu(); renderCart();