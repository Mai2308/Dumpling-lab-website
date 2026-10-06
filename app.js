const STORAGE_KEYS = { authToken: 'dumpling-lab-auth-token' };
const starterCategories = ['Dumplings', 'Noodles', 'Sauces', 'Beverages'];
const dumplingStyles = ['Steamed', 'Pan-fried', 'Crispy skirt'];
const starterItems = [
  { id: 'item-1', name: 'Ginger cloud', category: 'Dumplings', price: 185, description: 'Chicken, fresh ginger, and a little spring onion tucked into soft, silky wrappers.', image: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?auto=format&fit=crop&w=900&q=85', tag: 'HOUSE FAVOURITE' },
  { id: 'item-2', name: 'Golden crunch', category: 'Dumplings', price: 210, description: 'Crispy-bottomed parcels, juicy chicken, and sesame soy for dipping.', image: 'https://images.unsplash.com/photo-1562802378-063ec186a863?auto=format&fit=crop&w=900&q=85', tag: 'CRISPY LITTLE THING' },
  { id: 'item-3', name: 'Mushroom moon', category: 'Dumplings', price: 195, description: 'Earthy shiitake, cabbage, and garlic chives. A lovely little plant-based parcel.', image: 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=900&q=85', tag: 'PLANT-BASED' },
  { id: 'item-4', name: 'Chilli oil crush', category: 'Dumplings', price: 220, description: 'Pork, a slow-building chilli warmth, and a crackly golden skirt.', image: 'https://images.unsplash.com/photo-1562802378-063ec186a863?auto=format&fit=crop&w=900&q=85', tag: 'A LITTLE HEAT' },
  { id: 'item-5', name: 'The dipping trio', category: 'Sauces', price: 75, description: 'House soy, ginger vinegar, and the chilli oil that started it all.', image: 'https://images.unsplash.com/photo-1472476443507-c7a5948772fc?auto=format&fit=crop&w=900&q=85', tag: 'THREE IS THE MAGIC NUMBER' },
  { id: 'item-6', name: 'Sesame clouds', category: 'Dumplings', price: 125, description: 'Warm, pillowy sesame buns with a molten sweet black sesame centre.', image: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=900&q=85', tag: 'SOMETHING SWEET' }
];
const state = {
  categories: starterCategories,
  items: starterItems,
  selectedCategory: 'All',
  cart: {},
  managing: false,
  offers: [],
  authToken: sessionStorage.getItem(STORAGE_KEYS.authToken),
  user: null,
  orders: [],
  orderPoll: null
};
const money = value => `EGP ${Number(value).toLocaleString('en-EG')}`;
const byId = id => document.getElementById(id);
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fallbackImage = 'https://images.unsplash.com/photo-1563245372-f21724e3856d?auto=format&fit=crop&w=900&q=75';

function isAdmin() {
  return state.user?.role === 'admin';
}

function updateRoleControls() {
  byId('orders-open').hidden = !isAdmin();
  byId('manage-toggle').hidden = !isAdmin();
}

function acceptAuth(result) {
  state.authToken = result.token;
  state.user = result.user;
  sessionStorage.setItem(STORAGE_KEYS.authToken, result.token);
  byId('account-open').textContent = result.user.role === 'admin' ? 'Sign out (admin)' : 'Sign out';
  updateRoleControls();
  renderMenu();
  loadOffers().catch(error => showToast(error.message));
}

function signOut(showConfirmation = true) {
  state.authToken = null;
  state.user = null;
  state.managing = false;
  sessionStorage.removeItem(STORAGE_KEYS.authToken);
  document.body.classList.remove('manage-mode');
  byId('manage-label').textContent = 'Manage';
  byId('manage-toggle').setAttribute('aria-pressed', 'false');
  byId('account-open').textContent = 'Sign in';
  updateRoleControls();
  clearInterval(state.orderPoll);
  byId('orders-content').hidden = true;
  renderMenu();
  loadOffers().catch(error => showToast(error.message));
  if (showConfirmation) showToast('You have signed out.');
}

async function apiRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.authToken) headers.Authorization = `Bearer ${state.authToken}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && state.authToken) signOut(false);
    throw new Error(result?.error || 'The request could not be completed.');
  }
  return result;
}

async function loadMenu() {
  const result = await apiRequest('/api/menu');
  state.categories = result.categories;
  state.items = result.items;
  if (!state.categories.includes(state.selectedCategory)) state.selectedCategory = 'All';
}

async function loadOffers() {
  const result = await apiRequest(`/api/offers${isAdmin() ? '?all=true' : ''}`);
  state.offers = result.offers;
  renderOffers();
}

function renderOffers() {
  const section = byId('offers-section');
  section.hidden = !state.offers.length && !isAdmin();
  byId('offer-add').hidden = !state.managing || !isAdmin();
  byId('offers-grid').innerHTML = state.offers.map(offer => `<article class="offer-card"><span class="offer-discount">${Number(offer.discountPercent)}% off${isAdmin() && !offer.active ? ' · hidden' : ''}</span><h3>${escapeHTML(offer.title)}</h3><p>${escapeHTML(offer.description || '')}</p>${state.managing && isAdmin() ? `<div class="offer-manage"><button type="button" data-offer-edit="${escapeHTML(offer.id)}">Edit</button><button type="button" data-offer-delete="${escapeHTML(offer.id)}">Remove</button></div>` : ''}</article>`).join('');
  byId('offers-grid').querySelectorAll('[data-offer-edit]').forEach(button => button.addEventListener('click', () => openOfferDialog(button.dataset.offerEdit)));
  byId('offers-grid').querySelectorAll('[data-offer-delete]').forEach(button => button.addEventListener('click', () => removeOffer(button.dataset.offerDelete)));
}

function renderCategories() {
  const tabs = byId('category-tabs');
  tabs.innerHTML = ['All', ...state.categories].map(category => `<button class="category-tab ${state.selectedCategory === category ? 'active' : ''}" data-category="${escapeHTML(category)}" type="button">${escapeHTML(category)}</button>`).join('');
  tabs.querySelectorAll('.category-tab').forEach(button => button.addEventListener('click', event => {
    state.selectedCategory = event.currentTarget.dataset.category;
    renderMenu();
  }));
}

function renderMenu() {
  renderCategories();
  const visibleItems = state.items.filter(item => state.selectedCategory === 'All' || item.category === state.selectedCategory);
  byId('menu-count').textContent = `${visibleItems.length} ${visibleItems.length === 1 ? 'little lovely' : 'little lovelies'}`;
  byId('menu-empty').hidden = visibleItems.length > 0;
  byId('product-grid').innerHTML = visibleItems.map(item => `<article class="product-card"><div class="product-image-wrap"><img class="product-image" src="${escapeHTML(item.image || fallbackImage)}" alt="${escapeHTML(item.name)} dumplings" loading="lazy"><span class="product-tag">${escapeHTML(item.tag || item.category)}</span>${state.managing && isAdmin() ? `<div class="card-manage"><button type="button" data-edit="${escapeHTML(item.id)}" aria-label="Edit ${escapeHTML(item.name)}" title="Edit dish">✎</button><button type="button" data-delete="${escapeHTML(item.id)}" aria-label="Remove ${escapeHTML(item.name)}" title="Remove dish">×</button></div>` : ''}</div><div class="product-info"><div class="product-title-row"><h3 class="product-title">${escapeHTML(item.name)}</h3><span class="product-price">${money(item.price)}</span></div><p class="product-description">${escapeHTML(item.description || '')}</p><div class="product-bottom"><span class="product-category">${escapeHTML(item.category)}</span>${item.category === 'Dumplings' ? `<label class="style-choice">How would you like it?<select data-style="${escapeHTML(item.id)}" aria-label="Choose a style for ${escapeHTML(item.name)}">${dumplingStyles.map(style => `<option value="${escapeHTML(style)}">${escapeHTML(style)}</option>`).join('')}</select></label>` : ''}<button class="add-to-bag" type="button" data-add="${escapeHTML(item.id)}" aria-label="Add ${escapeHTML(item.name)} to bag">+</button></div></div></article>`).join('');
  byId('product-grid').querySelectorAll('.product-image').forEach(image => image.addEventListener('error', () => { if (image.src !== fallbackImage) image.src = fallbackImage; }, { once: true }));
  byId('product-grid').querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => {
    const style = byId('product-grid').querySelector(`[data-style="${CSS.escape(button.dataset.add)}"]`)?.value || '';
    addToCart(button.dataset.add, style);
  }));
  byId('product-grid').querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openItemDialog(button.dataset.edit)));
  byId('product-grid').querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => removeItem(button.dataset.delete)));
}

function getCartSelection(key) {
  const separatorIndex = key.indexOf('::');
  return separatorIndex < 0
    ? { id: key, style: '' }
    : { id: key.slice(0, separatorIndex), style: key.slice(separatorIndex + 2) };
}

function renderCart() {
  const entries = Object.entries(state.cart).filter(([, quantity]) => quantity > 0);
  const count = entries.reduce((total, [, quantity]) => total + quantity, 0);
  const subtotal = entries.reduce((total, [key, quantity]) => total + (state.items.find(item => item.id === getCartSelection(key).id)?.price ?? 0) * quantity, 0);
  byId('cart-count').textContent = count;
  byId('drawer-count').textContent = `(${count})`;
  byId('cart-subtotal').textContent = money(subtotal);
  byId('checkout-total').textContent = money(subtotal);
  byId('cart-empty').hidden = count > 0;
  byId('cart-summary').hidden = count === 0;
  byId('cart-lines').innerHTML = entries.map(([key, quantity]) => {
    const { id, style } = getCartSelection(key);
    const item = state.items.find(entry => entry.id === id);
    if (!item) return '';
    return `<article class="cart-line"><img src="${escapeHTML(item.image || fallbackImage)}" alt=""><div><h3>${escapeHTML(item.name)}</h3>${style ? `<p>${escapeHTML(style)}</p>` : ''}<p>${money(item.price)}</p><div class="quantity-controls"><button type="button" data-cart-key="${escapeHTML(key)}" data-delta="-1" aria-label="Remove one ${escapeHTML(item.name)}">−</button><span>${quantity}</span><button type="button" data-cart-key="${escapeHTML(key)}" data-delta="1" aria-label="Add one ${escapeHTML(item.name)}">+</button></div></div><span class="line-total">${money(item.price * quantity)}</span></article>`;
  }).join('');
  byId('cart-lines').querySelectorAll('[data-cart-key]').forEach(button => button.addEventListener('click', () => {
    const selection = getCartSelection(button.dataset.cartKey);
    addToCart(selection.id, selection.style, Number(button.dataset.delta));
  }));
}

function addToCart(id, style = '', delta = 1) {
  const key = style ? `${id}::${style}` : id;
  state.cart[key] = Math.max(0, (state.cart[key] || 0) + delta);
  if (!state.cart[key]) delete state.cart[key];
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
  if (enabled && !isAdmin()) {
    byId('account-dialog').showModal();
    return;
  }
  state.managing = enabled;
  document.body.classList.toggle('manage-mode', enabled);
  byId('manage-label').textContent = enabled ? 'Done' : 'Manage';
  byId('manage-toggle').setAttribute('aria-pressed', String(enabled));
  byId('add-item').hidden = !enabled;
  renderMenu();
  renderOffers();
  showToast(enabled ? 'Menu management is on.' : 'Menu changes are saved.');
}

function openOfferDialog(id = null) {
  const form = byId('offer-form');
  const offer = state.offers.find(entry => entry.id === id);
  form.reset();
  form.elements.id.value = offer?.id ?? '';
  form.elements.title.value = offer?.title ?? '';
  form.elements.description.value = offer?.description ?? '';
  form.elements.discountPercent.value = offer?.discountPercent ?? 0;
  form.elements.active.checked = offer ? Boolean(offer.active) : true;
  byId('offer-dialog-title').textContent = offer ? 'Edit this offer' : 'Add an offer';
  byId('offer-dialog').showModal();
}

async function removeOffer(id) {
  const offer = state.offers.find(entry => entry.id === id);
  if (!offer || !confirm(`Remove “${offer.title}”?`)) return;
  try {
    await apiRequest(`/api/offers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.offers = state.offers.filter(entry => entry.id !== id);
    renderOffers();
    showToast('Offer removed.');
  } catch (error) { showToast(error.message); }
}

async function removeItem(id) {
  const item = state.items.find(entry => entry.id === id);
  if (!item || !confirm(`Remove “${item.name}” from the menu?`)) return;
  try {
    await apiRequest(`/api/menu/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.items = state.items.filter(entry => entry.id !== id);
    state.cart = Object.fromEntries(Object.entries(state.cart).filter(([key]) => getCartSelection(key).id !== id));
    renderMenu(); renderCart();
    showToast('Dish removed from the menu.');
  } catch (error) { showToast(error.message); }
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
  try {
    if (file) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('That photo could not be read. Please try another.'));
        reader.readAsDataURL(file);
      });
      image = (await apiRequest('/api/uploads', { method: 'POST', body: JSON.stringify({ dataUrl }) })).image;
    }
    const item = { id, name: form.elements.name.value.trim(), category: form.elements.category.value, price: Number(form.elements.price.value), description: form.elements.description.value.trim(), image, tag: previous?.tag || 'FOLDED FRESH' };
    const result = await apiRequest(previous ? `/api/menu/${encodeURIComponent(id)}` : '/api/menu', { method: previous ? 'PUT' : 'POST', body: JSON.stringify(item) });
    state.items = previous ? state.items.map(entry => entry.id === id ? result.item : entry) : [...state.items, result.item];
    byId('item-dialog').close(); renderMenu(); renderCart();
    showToast(previous ? 'Your dish has been updated.' : 'A new dish joins the menu.');
  } catch (error) { showToast(error.message); }
});

byId('add-item').addEventListener('click', () => openItemDialog());
byId('offer-add').addEventListener('click', () => openOfferDialog());
byId('offer-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value || `offer-${crypto.randomUUID()}`;
  const existing = state.offers.some(offer => offer.id === id);
  const offer = {
    id,
    title: form.elements.title.value.trim(),
    description: form.elements.description.value.trim(),
    discountPercent: Number(form.elements.discountPercent.value),
    active: form.elements.active.checked
  };
  try {
    const result = await apiRequest(existing ? `/api/offers/${encodeURIComponent(id)}` : '/api/offers', { method: existing ? 'PUT' : 'POST', body: JSON.stringify(offer) });
    state.offers = existing ? state.offers.map(entry => entry.id === id ? result.offer : entry) : [...state.offers, result.offer];
    byId('offer-dialog').close();
    renderOffers();
    showToast(existing ? 'Offer updated.' : 'Offer added.');
  } catch (error) { showToast(error.message); }
});

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
      email: form.elements.email.value.trim(),
      address: form.elements.address.value.trim(),
      payment: form.elements.payment.value,
      items: entries.map(([key, quantity]) => {
        const selection = getCartSelection(key);
        return { id: selection.id, quantity, style: selection.style };
      })
    };
    const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderPayload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Your order could not be sent. Please try again.');
    const order = result.order;
    byId('order-confirmation').textContent = `Order ${order.id} is in the kitchen for ${order.customer}. We’ll call ${order.phone} and email a confirmation to ${order.customerEmail || order.email || 'your inbox'} about the delivery details.`;
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

async function loadOrders() {
  const result = await apiRequest('/api/orders');
  state.orders = result.orders;
  byId('orders-content').hidden = false;
  byId('orders-auth-message').hidden = true;
  byId('orders-signin').hidden = true;
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
  byId('orders-list').innerHTML = count ? state.orders.map(order => `<article class="order-card"><div class="order-card-head"><div><span class="order-id">${escapeHTML(order.id)}</span><time>${new Date(order.createdAt).toLocaleString()}</time></div><strong>${money(order.subtotal)}</strong></div><div class="order-customer"><strong>${escapeHTML(order.customer)}</strong><a href="tel:${escapeHTML(order.phone)}">${escapeHTML(order.phone)}</a>${order.customerEmail ? `<a href="mailto:${escapeHTML(order.customerEmail)}">${escapeHTML(order.customerEmail)}</a>` : ''}<span>${escapeHTML(order.address)}</span></div><div class="order-items">${order.items.map(item => `<span>${item.quantity} × ${escapeHTML(item.name)}${item.style ? ` · ${escapeHTML(item.style)}` : ''}</span>`).join('')}<span class="order-payment">${escapeHTML(order.payment)}</span></div><div class="order-card-foot"><span class="notification-state">${escapeHTML(order.notification_status)}</span><label>Status<select data-order-status="${escapeHTML(order.id)}">${['New', 'Preparing', 'Out for delivery', 'Completed', 'Cancelled'].map(status => `<option${status === order.status ? ' selected' : ''}>${status}</option>`).join('')}</select></label></div></article>`).join('') : '<div class="orders-empty">No orders yet. New customer orders will appear here.</div>';
  byId('orders-list').querySelectorAll('[data-order-status]').forEach(select => select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      const result = await apiRequest(`/api/orders/${encodeURIComponent(select.dataset.orderStatus)}/status`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) });
      state.orders = state.orders.map(order => order.id === result.order.id ? result.order : order);
      renderOrders();
    } catch (error) { showToast(error.message); select.disabled = false; }
  }));
}

byId('orders-export').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/orders.csv', { headers: { Authorization: `Bearer ${state.authToken}` } });
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
  if (!isAdmin()) {
    if (state.user) showToast('Administrator access is required for restaurant orders.');
    else byId('account-dialog').showModal();
    return;
  }
  byId('orders-dialog').showModal();
  try { await loadOrders(); }
  catch (error) {
    byId('orders-content').hidden = true;
    byId('orders-auth-message').textContent = error.message;
    byId('orders-auth-message').hidden = false;
    byId('orders-signin').hidden = false;
  }
  clearInterval(state.orderPoll);
  state.orderPoll = setInterval(() => {
    if (byId('orders-dialog').open && isAdmin()) loadOrders().catch(error => showToast(error.message));
  }, 20_000);
});
byId('orders-close').addEventListener('click', () => { byId('orders-dialog').close(); clearInterval(state.orderPoll); });

byId('manage-toggle').addEventListener('click', () => setManaging(!state.managing));
byId('account-open').addEventListener('click', () => {
  if (state.user) {
    signOut();
    return;
  }
  byId('account-dialog').showModal();
});
byId('orders-signin').addEventListener('click', () => {
  byId('orders-dialog').close();
  byId('account-dialog').showModal();
});
byId('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = byId('account-message');
  message.textContent = 'Signing in…';
  try {
    const result = await apiRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value.trim(), password: form.elements.password.value }) });
    acceptAuth(result);
    byId('account-dialog').close();
    showToast(isAdmin() ? 'Administrator access enabled.' : 'Signed in with read-only access.');
  } catch (error) { message.textContent = error.message; }
});
byId('account-signup').addEventListener('click', async () => {
  const form = byId('account-form');
  const message = byId('account-message');
  message.textContent = 'Creating your customer account…';
  try {
    const result = await apiRequest('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value.trim(), password: form.elements.password.value }) });
    acceptAuth(result);
    byId('account-dialog').close();
    showToast('Customer account created. Menu editing is reserved for admins.');
  } catch (error) { message.textContent = error.message; }
});
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

async function initializeApp() {
  if (state.authToken) {
    try {
      const result = await apiRequest('/api/auth/me');
      state.user = result.user;
      byId('account-open').textContent = result.user.role === 'admin' ? 'Sign out (admin)' : 'Sign out';
    } catch (error) {
      state.authToken = null;
      sessionStorage.removeItem(STORAGE_KEYS.authToken);
    }
  }
  updateRoleControls();
  try { await loadMenu(); }
  catch (error) { showToast(error.message); }
  try { await loadOffers(); }
  catch (error) { showToast(error.message); }
  renderMenu();
  renderOffers();
  renderCart();
}

initializeApp();