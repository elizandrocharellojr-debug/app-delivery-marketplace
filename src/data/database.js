(function bootstrapDatabase() {
  var storageKey = "morretes-delivery-db";
  var cartKey = "morretes-delivery-cart";
  var ordersKey = "morretes-delivery-orders";
  var profileKey = "morretes-delivery-profile";
  var favoritesKey = "morretes-delivery-favorites";
  var ownerSessionKey = "morretes-delivery-owner-session";
  var customerSessionKey = "morretes-delivery-customer-session";
  var partnerLeadsKey = "morretes-delivery-partner-leads";
  var defaultData = window.MORRETES_SEED;
  var defaultProfile = {
    name: "Cliente Morretes",
    phone: "(41) 99999-0000",
    addresses: [
      {
        id: "address-home",
        street: "Rua XV de Novembro",
        number: "120",
        district: "Centro",
        city: "Morretes",
        zipCode: "83350-000",
        reference: "Centro, Morretes - PR",
      },
    ],
    defaultAddressId: "address-home",
  };

  function clone(data) {
    return JSON.parse(JSON.stringify(data));
  }

  function parseJson(raw, fallback) {
    if (!raw) {
      return clone(fallback);
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      return clone(fallback);
    }
  }

  function parseMoney(value) {
    return Number(String(value).replace("R$", "").replace(".", "").replace(",", ".").trim());
  }

  function formatMoney(value) {
    return value.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      switch (char) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  function sanitizeUrl(value) {
    var url = sanitizeText(value);

    if (!url) {
      return "";
    }

    if (/^(\.\/|\/|https?:\/\/|data:image\/)/i.test(url)) {
      return url;
    }

    return "";
  }

  function mergeSeedAccounts(parsed) {
    var changed = false;

    parsed.owners = parsed.owners || [];
    parsed.customers = parsed.customers || [];

    (defaultData.owners || []).forEach(function (seedOwner) {
      var exists = parsed.owners.some(function (owner) {
        return owner.id === seedOwner.id || owner.storeId === seedOwner.storeId;
      });

      if (!exists) {
        parsed.owners.push(clone(seedOwner));
        changed = true;
      }
    });

    (defaultData.customers || []).forEach(function (seedCustomer) {
      var exists = parsed.customers.some(function (customer) {
        return customer.id === seedCustomer.id || customer.email === seedCustomer.email;
      });

      if (!exists) {
        parsed.customers.push(clone(seedCustomer));
        changed = true;
      }
    });

    if (changed) {
      save(parsed);
    }

    return parsed;
  }

  function sanitizeText(value) {
    return String(value || "").trim();
  }

  function formatAddress(address) {
    if (!address) {
      return "";
    }

    var street = sanitizeText(address.street);
    var number = sanitizeText(address.number);
    var district = sanitizeText(address.district);
    var city = sanitizeText(address.city);
    var zipCode = sanitizeText(address.zipCode);
    var reference = sanitizeText(address.reference);
    var parts = [];

    if (street || number) {
      parts.push([street, number].filter(Boolean).join(", "));
    }

    if (district) {
      parts.push(district);
    }

    if (city) {
      parts.push(city);
    }

    if (zipCode) {
      parts.push("CEP " + zipCode);
    }

    if (reference) {
      parts.push(reference);
    }

    if (!parts.length && address.address) {
      parts.push(sanitizeText(address.address));
    }

    return parts.join(" - ");
  }

  function normalizeAddress(address, fallbackId) {
    var normalized = {
      id: address.id || fallbackId || "address-" + Date.now(),
      street: sanitizeText(address.street),
      number: sanitizeText(address.number),
      district: sanitizeText(address.district),
      city: sanitizeText(address.city) || "Morretes",
      zipCode: sanitizeText(address.zipCode),
      reference: sanitizeText(address.reference),
    };

    if ((!normalized.street && !normalized.number) && address.address) {
      normalized.street = sanitizeText(address.address);
    }

    return normalized;
  }

  function getCurrentAddress(profile) {
    var currentProfile = profile || getProfile();

    return (
      currentProfile.addresses.find(function (item) {
        return item.id === currentProfile.defaultAddressId;
      }) || currentProfile.addresses[0] || null
    );
  }

  function parseOpeningHours(openingHours) {
    var match = String(openingHours || "").match(
      /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/
    );

    if (!match) {
      return null;
    }

    return {
      startMinutes: Number(match[1]) * 60 + Number(match[2]),
      endMinutes: Number(match[3]) * 60 + Number(match[4]),
    };
  }

  function getDayKey(date) {
    var keys = [
      "domingo",
      "segunda",
      "terca",
      "quarta",
      "quinta",
      "sexta",
      "sabado",
    ];

    return keys[(date || new Date()).getDay()];
  }

  function getOpeningHoursForDate(store, now) {
    var currentDate = now || new Date();
    var byDay = store && store.openingHoursByDay ? store.openingHoursByDay : null;
    var dayKey = getDayKey(currentDate);

    if (byDay && Object.keys(byDay).length) {
      return byDay[dayKey] || "";
    }

    return store && store.openingHours ? store.openingHours : "";
  }

  function isStoreOpen(store, now) {
    if (!store || store.isActive === false) {
      return false;
    }

    var parsedHours = parseOpeningHours(getOpeningHoursForDate(store, now));
    if (!parsedHours) {
      return true;
    }

    var currentDate = now || new Date();
    var currentMinutes = currentDate.getHours() * 60 + currentDate.getMinutes();

    if (parsedHours.endMinutes >= parsedHours.startMinutes) {
      return (
        currentMinutes >= parsedHours.startMinutes && currentMinutes <= parsedHours.endMinutes
      );
    }

    return (
      currentMinutes >= parsedHours.startMinutes || currentMinutes <= parsedHours.endMinutes
    );
  }

  function getDeliveryFeeForStore(store, addressOrProfile) {
    if (!store) {
      return 0;
    }

    var address = addressOrProfile && addressOrProfile.addresses
      ? getCurrentAddress(addressOrProfile)
      : addressOrProfile;
    var district = sanitizeText(address && address.district).toLowerCase();
    var districtFees = store.deliveryFeesByDistrict || {};

    if (district && districtFees[district] != null) {
      return Number(districtFees[district]);
    }

    return parseMoney(store.deliveryFee || 0);
  }

  function getDeliveryFeeLabelForStore(store, addressOrProfile) {
    return formatMoney(getDeliveryFeeForStore(store, addressOrProfile));
  }

  function createStatusHistoryEntry(status) {
    return {
      status: status,
      timestamp: new Date().toISOString(),
    };
  }

  function load() {
    var raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      window.localStorage.setItem(storageKey, JSON.stringify(defaultData));
      return clone(defaultData);
    }

    try {
      var parsed = JSON.parse(raw);

      var missingRequiredData =
        !parsed.categories ||
        !parsed.stores ||
        !parsed.owners ||
        !parsed.customers;

      if (!parsed.version || parsed.version < defaultData.version || missingRequiredData) {
        window.localStorage.setItem(storageKey, JSON.stringify(defaultData));
        return clone(defaultData);
      }

      return mergeSeedAccounts(parsed);
    } catch (error) {
      window.localStorage.setItem(storageKey, JSON.stringify(defaultData));
      return clone(defaultData);
    }
  }

  function save(data) {
    window.localStorage.setItem(storageKey, JSON.stringify(data));
    return data;
  }

  function syncCatalogFromServer() {
    if (!window.fetch) {
      return Promise.resolve(load());
    }

    return window
      .fetch("/api/catalog", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Falha ao carregar catálogo.");
        }
        return response.json();
      })
      .then(function (catalog) {
        var current = load();
        current.version = catalog.version || current.version;
        current.city = catalog.city || current.city;
        current.state = catalog.state || current.state;
        current.categories = Array.isArray(catalog.categories) ? catalog.categories : current.categories;
        current.owners = Array.isArray(catalog.owners) ? catalog.owners : current.owners;
        current.stores = Array.isArray(catalog.stores) ? catalog.stores : current.stores;
        save(current);
        return current;
      })
      .catch(function () {
        return load();
      });
  }

  function getOwnerAuthHeaders() {
    var session = getOwnerSession();
    if (!session || !session.token) {
      return {};
    }
    return { Authorization: "Bearer " + session.token };
  }

  function getCustomerAuthHeaders() {
    var session = getCustomerSession();
    if (!session || !session.token) {
      return {};
    }
    return { Authorization: "Bearer " + session.token };
  }

  // A senha só pode ser trocada pela tela de login (via "Esqueci minha
  // senha"), não mais de dentro do painel já logado - isso aqui só deixa o
  // lojista cadastrar/atualizar o e-mail de recuperação da conta.
  function updateOwnerEmail(email) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/auth/owner-update-email", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, getOwnerAuthHeaders()),
        body: JSON.stringify({ email: email }),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            return { error: (result && result.error) || "Não foi possível salvar o e-mail." };
          }
          return result;
        });
      })
      .catch(function () {
        return { error: "Não foi possível salvar o e-mail agora." };
      });
  }

  // Envia a foto escolhida no painel para o servidor, que salva o arquivo
  // de verdade em assets/items/ e devolve a URL - em vez de embutir a
  // imagem inteira em base64 dentro do catálogo.
  function uploadItemPhoto(dataUrl) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/uploads/item-photo", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, getOwnerAuthHeaders()),
        body: JSON.stringify({ dataUrl: dataUrl }),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            return { error: (result && result.error) || "Não foi possível enviar a foto." };
          }
          return result;
        });
      })
      .catch(function () {
        return { error: "Não foi possível enviar a foto agora." };
      });
  }

  // Abre uma conexão WebSocket com o servidor para o painel do lojista
  // saber na hora quando chega um pedido novo ou o status de um pedido
  // muda, sem precisar esperar o próximo ciclo de sincronizacao.
  function connectOwnerOrdersSocket(onEvent) {
    if (!window.WebSocket) {
      return null;
    }

    var session = getOwnerSession();
    if (!session || !session.storeId || !session.token) {
      return null;
    }

    var reconnectDelay = 2000;
    var closedByClient = false;
    var socket = null;

    function connect() {
      var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      var url =
        protocol +
        "//" +
        window.location.host +
        "/ws/orders?storeId=" +
        encodeURIComponent(session.storeId) +
        "&token=" +
        encodeURIComponent(session.token);

      socket = new window.WebSocket(url);

      socket.onmessage = function (event) {
        try {
          onEvent(JSON.parse(event.data));
        } catch (error) {
          onEvent(null);
        }
      };

      socket.onclose = function () {
        if (closedByClient) {
          return;
        }
        window.setTimeout(connect, reconnectDelay);
      };

      socket.onerror = function () {
        socket.close();
      };
    }

    connect();

    return {
      close: function () {
        closedByClient = true;
        if (socket) {
          socket.close();
        }
      },
    };
  }

  // Abre uma conexão WebSocket pro painel do taxista saber na hora quando
  // aparece uma corrida nova, alguém aceita uma corrida por perto, ou a
  // corrida ativa dele muda de status/valor - sem precisar esperar o
  // próximo ciclo de sincronizacao.
  function connectTaxiDriverSocket(token, onEvent, onStatusChange) {
    if (!window.WebSocket || !token) {
      return null;
    }

    var reconnectDelay = 2000;
    var closedByClient = false;
    var socket = null;
    var everOpened = false;

    function notifyStatus(status) {
      if (typeof onStatusChange === "function") {
        onStatusChange(status);
      }
    }

    function connect() {
      var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      var url =
        protocol + "//" + window.location.host + "/ws/taxi?role=driver&token=" + encodeURIComponent(token);

      socket = new window.WebSocket(url);

      socket.onopen = function () {
        everOpened = true;
        notifyStatus("connected");
      };

      socket.onmessage = function (event) {
        try {
          onEvent(JSON.parse(event.data));
        } catch (error) {
          onEvent(null);
        }
      };

      socket.onclose = function () {
        if (everOpened) {
          notifyStatus("disconnected");
        }
        everOpened = false;
        if (closedByClient) {
          return;
        }
        window.setTimeout(connect, reconnectDelay);
      };

      socket.onerror = function () {
        socket.close();
      };
    }

    connect();

    return {
      close: function () {
        closedByClient = true;
        if (socket) {
          socket.close();
        }
      },
    };
  }

  // Abre uma conexão WebSocket pra acompanhar uma corrida específica (tela
  // do cliente) - avisa na hora quando o status muda ou o taxista se move,
  // sem precisar de login (igual a consulta por GET /api/rides/:id).
  function connectRideSocket(rideId, onEvent, onStatusChange) {
    if (!window.WebSocket || !rideId) {
      return null;
    }

    var reconnectDelay = 2000;
    var closedByClient = false;
    var socket = null;
    var everOpened = false;

    function notifyStatus(status) {
      if (typeof onStatusChange === "function") {
        onStatusChange(status);
      }
    }

    function connect() {
      var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      var url =
        protocol + "//" + window.location.host + "/ws/taxi?role=ride&rideId=" + encodeURIComponent(rideId);

      socket = new window.WebSocket(url);

      socket.onopen = function () {
        everOpened = true;
        notifyStatus("connected");
      };

      socket.onmessage = function (event) {
        try {
          onEvent(JSON.parse(event.data));
        } catch (error) {
          onEvent(null);
        }
      };

      socket.onclose = function () {
        if (everOpened) {
          notifyStatus("disconnected");
        }
        everOpened = false;
        if (closedByClient) {
          return;
        }
        window.setTimeout(connect, reconnectDelay);
      };

      socket.onerror = function () {
        socket.close();
      };
    }

    connect();

    return {
      close: function () {
        closedByClient = true;
        if (socket) {
          socket.close();
        }
      },
    };
  }

  function pushStoreToServer(storePayload) {
    if (!window.fetch) {
      return Promise.resolve(storePayload);
    }

    return window
      .fetch("/api/stores/upsert", {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          getOwnerAuthHeaders()
        ),
        body: JSON.stringify(storePayload),
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Falha ao salvar loja no servidor.");
        }
        return response.json();
      })
      .then(function (result) {
        var data = load();
        var store = result.store;
        var index = data.stores.findIndex(function (currentStore) {
          return currentStore.id === store.id;
        });

        if (index >= 0) {
          data.stores[index] = store;
        } else {
          data.stores.push(store);
        }

        save(data);
        return store;
      });
  }

  function pushStoreItemToServer(storeId, itemPayload, itemId, preferredIndex) {
    if (!window.fetch) {
      return Promise.resolve(null);
    }

    return window
      .fetch("/api/stores/upsert-item", {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          getOwnerAuthHeaders()
        ),
        body: JSON.stringify({
          storeId: storeId,
          item: itemPayload,
          itemId: itemId,
          preferredIndex: preferredIndex,
        }),
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Falha ao salvar item no servidor.");
        }
        return response.json();
      })
      .then(function (result) {
        var data = load();
        var store = result.store;
        var index = data.stores.findIndex(function (currentStore) {
          return currentStore.id === store.id;
        });

        if (index >= 0) {
          data.stores[index] = store;
        } else {
          data.stores.push(store);
        }

        save(data);
        return result;
      });
  }

  function getStoresByCategory(categoryId) {
    return load().stores.filter(function (store) {
      return store.categoryId === categoryId && store.isActive !== false;
    });
  }

  function getCategories() {
    return load().categories;
  }

  function getOwners() {
    return load().owners || [];
  }

  function getCustomers() {
    return load().customers || [];
  }

  function getCustomerByEmail(email) {
    return getCustomers().find(function (customer) {
      return customer.email === email;
    });
  }

  // Guarda só os dados públicos do cliente (sem senha) para uso offline da
  // tela de perfil. A autenticação de verdade sempre passa pelo servidor.
  function upsertLocalCustomer(customerPayload) {
    var data = load();
    var email = sanitizeText(customerPayload && customerPayload.email).toLowerCase();
    var address = normalizeAddress(
      customerPayload && customerPayload.address ? customerPayload.address : {},
      "address-home"
    );
    var nextCustomer = {
      id: customerPayload.id || "customer-" + Date.now(),
      name: sanitizeText(customerPayload && customerPayload.name),
      cpf: sanitizeText(customerPayload && customerPayload.cpf).replace(/\D/g, ""),
      email: email,
      phone: sanitizeText(customerPayload && customerPayload.phone),
      address: address,
    };
    var customerIndex = data.customers.findIndex(function (customer) {
      return customer.email === email;
    });

    if (customerIndex >= 0) {
      data.customers[customerIndex] = Object.assign({}, data.customers[customerIndex], nextCustomer);
    } else {
      data.customers.push(nextCustomer);
    }

    save(data);
    return nextCustomer;
  }

  function syncCustomerFromServer(customerPayload) {
    return upsertLocalCustomer(customerPayload);
  }


  function getCategoryById(categoryId) {
    return load().categories.find(function (category) {
      return category.id === categoryId;
    });
  }

  function getStoreById(storeId) {
    return load().stores.find(function (store) {
      return store.id === storeId;
    });
  }

  function getStoreSections(storeId) {
    var store = getStoreById(storeId);
    if (!store) {
      return [];
    }

    var sections = [];
    store.items.forEach(function (item) {
      var section = item.section || "Geral";
      if (sections.indexOf(section) === -1) {
        sections.push(section);
      }
    });
    return sections;
  }

  function updateOwnerStoreName(storeId, storeName) {
    var data = load();
    if (!data.owners) {
      return;
    }

    data.owners = data.owners.map(function (owner) {
      if (owner.storeId === storeId) {
        owner.storeName = storeName;
      }
      return owner;
    });
    save(data);
  }

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function upsertStore(storePayload) {
    var data = load();
    var existingIndex = data.stores.findIndex(function (store) {
      return store.id === storePayload.id;
    });

    if (existingIndex >= 0) {
      data.stores[existingIndex] = storePayload;
    } else {
      data.stores.unshift(storePayload);
    }

    save(data);
    updateOwnerStoreName(storePayload.id, storePayload.name);
    pushStoreToServer(storePayload).catch(function () {});
    return storePayload;
  }

  function createStore(storePayload) {
    var idBase = slugify(storePayload.name || "loja");
    var id = idBase;
    var suffix = 1;
    var data = load();

    while (
      data.stores.some(function (store) {
        return store.id === id;
      })
    ) {
      suffix += 1;
      id = idBase + "-" + suffix;
    }

    var newStore = {
      id: id,
      categoryId: storePayload.categoryId,
      name: storePayload.name,
      icon: storePayload.icon,
      logoUrl: storePayload.logoUrl || "",
      coverLabel: storePayload.coverLabel,
      description: storePayload.description,
      rating: storePayload.rating,
      deliveryTime: storePayload.deliveryTime,
      deliveryFee: storePayload.deliveryFee,
      minOrder: storePayload.minOrder || 0,
      openingHours: storePayload.openingHours || "",
      openingHoursByDay: storePayload.openingHoursByDay || {},
      deliveryFeesByDistrict: storePayload.deliveryFeesByDistrict || {},
      isActive: storePayload.isActive !== false,
      priceRange: storePayload.priceRange,
      tags: storePayload.tags || [],
      items: storePayload.items || [],
    };

    return upsertStore(newStore);
  }

  function deleteStore(storeId) {
    var data = load();
    data.stores = data.stores.filter(function (store) {
      return store.id !== storeId;
    });
    if (data.owners) {
      data.owners = data.owners.filter(function (owner) {
        return owner.storeId !== storeId;
      });
    }
    save(data);
  }

  function saveStoreItems(storeId, items) {
    var store = getStoreById(storeId);

    if (!store) {
      return null;
    }

    store.items = items.map(function (item, index) {
      var existingItem = item.id
        ? (store.items || []).find(function (currentItem) {
            return currentItem.id === item.id;
          })
        : null;
      var promoPrice = item.promoPrice != null && item.promoPrice !== ""
        ? Number(item.promoPrice)
        : null;
      return {
        id: item.id || "item-" + Date.now() + "-" + index,
        name: item.name,
        price: Number(item.price),
        promoPrice: promoPrice,
        section: item.section || "Geral",
        description: item.description || "",
        available: item.available !== false,
        photoUrl: item.photoUrl || (existingItem && existingItem.photoUrl) || "",
      };
    });

    return upsertStore(store);
  }

  function upsertStoreItem(storeId, itemPayload, itemId, preferredIndex) {
    var data = load();
    var storeIndex = data.stores.findIndex(function (store) {
      return store.id === storeId;
    });
    var store;
    var targetIndex = -1;
    var promoPrice;
    var normalizedItem;
    var existingItem;

    if (storeIndex < 0) {
      return null;
    }

    store = data.stores[storeIndex];
    store.items = Array.isArray(store.items) ? store.items : [];

    if (itemId) {
      targetIndex = store.items.findIndex(function (item) {
        return item.id === itemId;
      });
    }

    if (targetIndex < 0 && preferredIndex >= 0 && preferredIndex < store.items.length) {
      targetIndex = preferredIndex;
    }

    existingItem = targetIndex >= 0 ? store.items[targetIndex] : null;

    promoPrice =
      itemPayload.promoPrice != null && itemPayload.promoPrice !== ""
        ? Number(itemPayload.promoPrice)
        : null;

    normalizedItem = {
      id:
        itemId ||
        itemPayload.id ||
        "item-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
      name: itemPayload.name,
      price: Number(itemPayload.price || 0),
      promoPrice: promoPrice,
      section: itemPayload.section || "Geral",
      description: itemPayload.description || "",
      available: itemPayload.available !== false,
      photoUrl: itemPayload.photoUrl || (existingItem && existingItem.photoUrl) || "",
    };

    if (targetIndex >= 0) {
      store.items[targetIndex] = normalizedItem;
    } else {
      store.items.push(normalizedItem);
    }

    data.stores[storeIndex] = store;
    save(data);
    updateOwnerStoreName(store.id, store.name);
    pushStoreItemToServer(store.id, normalizedItem, normalizedItem.id, targetIndex).catch(function () {});
    return clone(store);
  }

  function getItemById(store, itemId) {
    if (!store) {
      return null;
    }

    return store.items.find(function (item) {
      return item.id === itemId;
    });
  }

  function searchStores(query) {
    var normalized = query.trim().toLowerCase();
    if (!normalized) {
      return load().stores;
    }

    return load().stores.filter(function (store) {
      if (store.isActive === false) {
        return false;
      }
      var haystack = [
        store.name,
        store.description,
        store.coverLabel,
        store.categoryId,
        store.tags.join(" "),
        store.items
          .map(function (item) {
            return item.name;
          })
          .join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.indexOf(normalized) >= 0;
    });
  }

  function searchCatalog(query, categoryId) {
    var normalized = query.trim().toLowerCase();
    var data = load();
    var stores = categoryId
      ? data.stores.filter(function (store) {
          return store.categoryId === categoryId && store.isActive !== false;
        })
      : data.stores.filter(function (store) {
          return store.isActive !== false;
        });

    if (!normalized) {
      return [];
    }

    var results = [];

    stores.forEach(function (store) {
      var storeHaystack = [
        store.name,
        store.description,
        store.coverLabel,
        store.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();

      if (storeHaystack.indexOf(normalized) >= 0) {
        results.push({
          type: "store",
          storeId: store.id,
          categoryId: store.categoryId,
          title: store.name,
          subtitle: store.coverLabel,
          meta: store.deliveryTime + " - " + store.deliveryFee,
        });
      }

      store.items.forEach(function (item) {
        if (item.available === false) {
          return;
        }
        var itemHaystack = [item.name, store.name, store.tags.join(" ")]
          .join(" ")
          .toLowerCase();

        if (itemHaystack.indexOf(normalized) >= 0) {
          results.push({
            type: "item",
            storeId: store.id,
            categoryId: store.categoryId,
            itemId: item.id,
            title: item.name,
            subtitle: store.name,
            meta: formatMoney(item.price),
          });
        }
      });
    });

    return results.slice(0, 8);
  }

  function getCart() {
    return parseJson(window.localStorage.getItem(cartKey), {
      storeId: null,
      items: [],
    });
  }

  function saveCart(cart) {
    window.localStorage.setItem(cartKey, JSON.stringify(cart));
    return cart;
  }

  function clearCart() {
    return saveCart({
      storeId: null,
      items: [],
    });
  }

  function addItemToCart(storeId, itemId) {
    var cart = getCart();
    var store = getStoreById(storeId);
    var item = getItemById(store, itemId);

    if (
      !store ||
      !item ||
      store.isActive === false ||
      item.available === false ||
      !isStoreOpen(store)
    ) {
      return null;
    }

    if (cart.storeId && cart.storeId !== storeId) {
      cart = {
        storeId: storeId,
        items: [],
      };
    }

    cart.storeId = storeId;

    var existing = cart.items.find(function (cartItem) {
      return cartItem.itemId === itemId;
    });

    if (existing) {
      existing.quantity += 1;
    } else {
      cart.items.push({
        itemId: itemId,
        quantity: 1,
      });
    }

    return saveCart(cart);
  }

  function updateCartItemQuantity(itemId, quantity) {
    var cart = getCart();
    cart.items = cart.items
      .map(function (item) {
        if (item.itemId === itemId) {
          return {
            itemId: item.itemId,
            quantity: quantity,
          };
        }

        return item;
      })
      .filter(function (item) {
        return item.quantity > 0;
      });

    if (!cart.items.length) {
      cart.storeId = null;
    }

    return saveCart(cart);
  }

  function removeCartItem(itemId) {
    return updateCartItemQuantity(itemId, 0);
  }

  function getCartDetailed() {
    var cart = getCart();

    if (!cart.storeId) {
      return {
        store: null,
        items: [],
        subtotal: 0,
        deliveryFee: 0,
        total: 0,
        totalItems: 0,
      };
    }

    var store = getStoreById(cart.storeId);

    if (!store) {
      return {
        store: null,
        items: [],
        subtotal: 0,
        deliveryFee: 0,
        total: 0,
        totalItems: 0,
      };
    }

    var items = cart.items
      .map(function (cartItem) {
        var item = getItemById(store, cartItem.itemId);
        if (!item) {
          return null;
        }

        return {
          itemId: item.id,
          name: item.name,
          price: getItemDisplayPrice(item),
          basePrice: Number(item.price || 0),
          promoPrice: item.promoPrice != null ? Number(item.promoPrice) : null,
          section: item.section || "Geral",
          description: item.description || "",
          quantity: cartItem.quantity,
          subtotal: getItemDisplayPrice(item) * cartItem.quantity,
        };
      })
      .filter(Boolean);

    var subtotal = items.reduce(function (total, item) {
      return total + item.subtotal;
    }, 0);
    var deliveryFee = parseMoney(store.deliveryFee);
    var profile = getProfile();
    var dynamicDeliveryFee = getDeliveryFeeForStore(store, profile);
    var totalItems = items.reduce(function (total, item) {
      return total + item.quantity;
    }, 0);

    return {
      store: store,
      items: items,
      subtotal: subtotal,
      deliveryFee: dynamicDeliveryFee,
      deliveryFeeLabel: formatMoney(dynamicDeliveryFee),
      total: subtotal + dynamicDeliveryFee,
      totalItems: totalItems,
      minOrder: Number(store.minOrder || 0),
      currentAddress: getCurrentAddress(profile),
      isOpen: isStoreOpen(store),
    };
  }

  function getOrders() {
    return parseJson(window.localStorage.getItem(ordersKey), []);
  }

  function saveOrders(orders) {
    window.localStorage.setItem(ordersKey, JSON.stringify(orders));
    return orders;
  }

  // O pedido agora é criado no servidor (fonte da verdade), e só depois
  // guardado localmente para a tela "Meus pedidos" abrir na hora.
  function placeOrder(payload) {
    var cart = getCartDetailed();

    if (!cart.store || !cart.items.length) {
      return Promise.resolve(null);
    }

    if (!isStoreOpen(cart.store)) {
      return Promise.resolve(null);
    }

    if (!window.fetch) {
      return Promise.resolve(null);
    }

    var profile = getProfile();
    var customerSession = getCustomerSession();
    var currentAddress = getCurrentAddress(profile);
    var requestBody = {
      storeId: cart.store.id,
      items: cart.items.map(function (item) {
        return { itemId: item.itemId, quantity: item.quantity };
      }),
      paymentMethod: payload && payload.paymentMethod ? payload.paymentMethod : "Pix",
      notes: payload && payload.notes ? payload.notes : "",
      changeFor: payload && payload.changeFor != null ? payload.changeFor : null,
      customerId: customerSession && customerSession.customerId ? customerSession.customerId : "",
      customerName:
        sanitizeText(profile && profile.name) ||
        sanitizeText(customerSession && customerSession.customerName) ||
        "Cliente",
      customerPhone: sanitizeText(profile && profile.phone) || sanitizeText(payload && payload.customerPhone) || "",
      district: sanitizeText(currentAddress && currentAddress.district),
      address: formatAddress(currentAddress),
      couponCode: sanitizeText(payload && payload.couponCode),
    };

    return window
      .fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      })
      .then(function (response) {
        if (!response.ok) {
          return response.json().then(function (result) {
            throw new Error((result && result.error) || "Não foi possível finalizar o pedido.");
          });
        }
        return response.json();
      })
      .then(function (result) {
        var order = result.order;
        var orders = getOrders();
        orders.unshift(order);
        saveOrders(orders);
        clearCart();
        return order;
      });
  }

  function getProfile() {
    var profile = parseJson(window.localStorage.getItem(profileKey), defaultProfile);

    if (!profile.addresses) {
      profile.addresses = [
        normalizeAddress(
          {
            id: "address-home",
            address: profile.address || "Centro, Morretes - PR",
            reference: profile.reference || "Casa",
          },
          "address-home"
        ),
      ];
      profile.defaultAddressId = "address-home";
    }

    profile.addresses = profile.addresses.map(function (address, index) {
      return normalizeAddress(address, "address-" + (index + 1));
    });

    if (!profile.defaultAddressId && profile.addresses.length) {
      profile.defaultAddressId = profile.addresses[0].id;
    }

    return profile;
  }

  function saveProfile(profile) {
    window.localStorage.setItem(profileKey, JSON.stringify(profile));
    return profile;
  }

  function getOrdersByStore(storeId) {
    return getOrders().filter(function (order) {
      return order.storeId === storeId;
    });
  }

  function getOrderById(orderId) {
    return getOrders().find(function (order) {
      return order.id === orderId;
    }) || null;
  }

  function upsertLocalOrder(order) {
    if (!order) {
      return;
    }
    var orders = getOrders();
    var index = orders.findIndex(function (existing) {
      return existing.id === order.id;
    });

    if (index >= 0) {
      orders[index] = order;
    } else {
      orders.unshift(order);
    }

    saveOrders(orders);
  }

  function replaceLocalOrdersForStore(storeId, freshOrders) {
    var orders = getOrders().filter(function (order) {
      return order.storeId !== storeId;
    });
    saveOrders(orders.concat(freshOrders));
  }

  // Busca no servidor os pedidos da loja do lojista logado e atualiza o
  // cache local usado pelo painel. E isso que faz o painel enxergar
  // pedidos feitos em outros aparelhos.
  function syncOwnerOrdersFromServer(storeId) {
    if (!storeId || !window.fetch) {
      return Promise.resolve(getOrdersByStore(storeId));
    }

    return window
      .fetch("/api/orders?storeId=" + encodeURIComponent(storeId), {
        headers: getOwnerAuthHeaders(),
        cache: "no-store",
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Falha ao buscar pedidos.");
        }
        return response.json();
      })
      .then(function (result) {
        var orders = Array.isArray(result.orders) ? result.orders : [];
        replaceLocalOrdersForStore(storeId, orders);
        return orders;
      })
      .catch(function () {
        return getOrdersByStore(storeId);
      });
  }

  // Atualiza, no cache local do cliente, o status mais recente de cada
  // pedido já feito (o lojista pode ter mudado o status em outro
  // aparelho). Chamado periodicamente pela tela "Meus pedidos".
  function refreshCustomerOrdersFromServer() {
    var orders = getOrders();

    if (!orders.length || !window.fetch) {
      return Promise.resolve(orders);
    }

    return Promise.all(
      orders.map(function (order) {
        return window
          .fetch("/api/orders/" + encodeURIComponent(order.id), { cache: "no-store" })
          .then(function (response) {
            return response.ok ? response.json() : null;
          })
          .then(function (result) {
            return result && result.order ? result.order : order;
          })
          .catch(function () {
            return order;
          });
      })
    ).then(function (updatedOrders) {
      saveOrders(updatedOrders);
      return updatedOrders;
    });
  }

  function clearOrdersByStore(storeId) {
    if (!window.fetch) {
      return Promise.resolve([]);
    }

    return window
      .fetch("/api/orders/clear", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, getOwnerAuthHeaders()),
        body: JSON.stringify({ storeId: storeId }),
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Falha ao limpar pedidos.");
        }
        replaceLocalOrdersForStore(storeId, []);
        return [];
      });
  }

  function updateOrderStatus(orderId, status) {
    if (!window.fetch) {
      return Promise.resolve(null);
    }

    return window
      .fetch("/api/orders/" + encodeURIComponent(orderId) + "/status", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, getOwnerAuthHeaders()),
        body: JSON.stringify({ status: status }),
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Falha ao atualizar status do pedido.");
        }
        return response.json();
      })
      .then(function (result) {
        upsertLocalOrder(result.order);
        // Quando o pedido é cancelado com pagamento online já confirmado,
        // "refund" vem com o resultado da tentativa automática de estorno
        // (attempted/success/reason) - quem chamou decide se mostra algo.
        return { order: result.order, refund: result.refund || { attempted: false } };
      });
  }

  // Tenta estornar de novo um pedido cancelado cujo estorno automático
  // falhou (ex.: Mercado Pago fora do ar no momento do cancelamento).
  function refundOrder(orderId) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/orders/" + encodeURIComponent(orderId) + "/refund", {
        method: "POST",
        headers: getOwnerAuthHeaders(),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (result.order) {
            upsertLocalOrder(result.order);
          }
          if (!response.ok) {
            return { error: (result.refund && result.refund.reason) || result.error || "Não foi possível estornar." };
          }
          return { order: result.order, refund: result.refund };
        });
      })
      .catch(function () {
        return { error: "Não foi possível falar com o servidor agora." };
      });
  }

  // Consulta o status real do pagamento direto no Mercado Pago e atualiza
  // o pedido - usado quando o aviso automático (webhook) não chegou por
  // algum motivo (ex.: endereço do webhook desatualizado depois de trocar
  // de domínio).
  function syncOrderPayment(orderId) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/orders/" + encodeURIComponent(orderId) + "/sync-payment", {
        method: "POST",
        headers: getOwnerAuthHeaders(),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (result.order) {
            upsertLocalOrder(result.order);
          }
          if (!response.ok) {
            return { error: result.error || "Não foi possível verificar o pagamento." };
          }
          return { order: result.order, paymentStatus: result.paymentStatus };
        });
      })
      .catch(function () {
        return { error: "Não foi possível falar com o servidor agora." };
      });
  }

  // Cancelamento pelo próprio cliente (enquanto o pedido ainda não saiu
  // para entrega). O servidor já dispara o estorno automático se o
  // pagamento online já estava confirmado.
  function cancelOrderByCustomer(orderId) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/orders/" + encodeURIComponent(orderId) + "/cancel", {
        method: "POST",
        headers: getCustomerAuthHeaders(),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (result.order) {
            upsertLocalOrder(result.order);
          }
          if (!response.ok) {
            return { error: result.error || "Não foi possível cancelar o pedido." };
          }
          return { order: result.order, refund: result.refund };
        });
      })
      .catch(function () {
        return { error: "Não foi possível falar com o servidor agora." };
      });
  }

  function updateOrderPrepEstimate(orderId, prepEstimate) {
    if (!window.fetch) {
      return Promise.resolve(null);
    }

    return window
      .fetch("/api/orders/" + encodeURIComponent(orderId) + "/prep", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, getOwnerAuthHeaders()),
        body: JSON.stringify({ prepEstimate: prepEstimate }),
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Falha ao atualizar previsão do pedido.");
        }
        return response.json();
      })
      .then(function (result) {
        upsertLocalOrder(result.order);
        return result.order;
      });
  }

  function getNewOrdersCountByStore(storeId) {
    return getOrdersByStore(storeId).filter(function (order) {
      return order.status === "Novo";
    }).length;
  }

  // -- Avaliacoes de loja ---------------------------------------------------

  function submitReview(orderId, rating, comment) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: orderId, rating: rating, comment: comment || "" }),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            return { error: (result && result.error) || "Não foi possível enviar a avaliação." };
          }
          return result;
        });
      })
      .catch(function () {
        return { error: "Não foi possível enviar a avaliação agora." };
      });
  }

  function getStoreReviews(storeId) {
    if (!window.fetch) {
      return Promise.resolve({ reviews: [], averageRating: null, reviewsCount: 0 });
    }

    return window
      .fetch("/api/stores/" + encodeURIComponent(storeId) + "/reviews", { cache: "no-store" })
      .then(function (response) {
        return response.ok ? response.json() : { reviews: [], averageRating: null, reviewsCount: 0 };
      })
      .catch(function () {
        return { reviews: [], averageRating: null, reviewsCount: 0 };
      });
  }

  // -- Moderação de avaliações (lojista dono da loja, ou admin entrando como
  // ela) - ver todas (inclusive escondidas) e esconder/reexibir uma -------

  function getStoreReviewsForModeration(storeId) {
    if (!window.fetch) {
      return Promise.resolve({ storeReviews: [], itemReviews: [] });
    }

    return window
      .fetch("/api/stores/" + encodeURIComponent(storeId) + "/reviews/manage", {
        cache: "no-store",
        headers: getOwnerAuthHeaders(),
      })
      .then(function (response) {
        return response.ok ? response.json() : { storeReviews: [], itemReviews: [] };
      })
      .catch(function () {
        return { storeReviews: [], itemReviews: [] };
      });
  }

  function setReviewVisibility(reviewId, hidden) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/reviews/" + encodeURIComponent(reviewId) + "/visibility", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, getOwnerAuthHeaders()),
        body: JSON.stringify({ hidden: hidden }),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            return { error: (result && result.error) || "Não foi possível atualizar a avaliação." };
          }
          return result;
        });
      })
      .catch(function () {
        return { error: "Não foi possível atualizar a avaliação agora." };
      });
  }

  function setItemReviewVisibility(reviewId, hidden) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/item-reviews/" + encodeURIComponent(reviewId) + "/visibility", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, getOwnerAuthHeaders()),
        body: JSON.stringify({ hidden: hidden }),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            return { error: (result && result.error) || "Não foi possível atualizar a avaliação." };
          }
          return result;
        });
      })
      .catch(function () {
        return { error: "Não foi possível atualizar a avaliação agora." };
      });
  }

  // -- Avaliacoes de item (ex.: comentario sobre uma peca de roupa) ---------

  function submitItemReview(orderId, itemId, rating, comment) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/item-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: orderId, itemId: itemId, rating: rating, comment: comment || "" }),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            return { error: (result && result.error) || "Não foi possível enviar a avaliação." };
          }
          return result;
        });
      })
      .catch(function () {
        return { error: "Não foi possível enviar a avaliação agora." };
      });
  }

  function getItemReviews(itemId) {
    if (!window.fetch) {
      return Promise.resolve({ reviews: [], averageRating: null, reviewsCount: 0 });
    }

    return window
      .fetch("/api/items/" + encodeURIComponent(itemId) + "/reviews", { cache: "no-store" })
      .then(function (response) {
        return response.ok ? response.json() : { reviews: [], averageRating: null, reviewsCount: 0 };
      })
      .catch(function () {
        return { reviews: [], averageRating: null, reviewsCount: 0 };
      });
  }

  // Marca localmente (por dispositivo) quais pedidos já foram avaliados,
  // para não repetir o formulário de avaliação na tela de pedidos.
  function getReviewedOrderIds() {
    return parseJson(window.localStorage.getItem("morretes-delivery-reviewed"), []);
  }

  function markOrderReviewed(orderId) {
    var reviewed = getReviewedOrderIds();
    if (reviewed.indexOf(orderId) < 0) {
      reviewed.push(orderId);
      window.localStorage.setItem("morretes-delivery-reviewed", JSON.stringify(reviewed));
    }
  }

  // Mesma ideia acima, mas por item dentro do pedido (uma peça pode ser
  // avaliada mesmo que o resto do pedido nao tenha sido, e vice-versa).
  // Cada chave e "orderId:itemId".
  function getReviewedItemKeys() {
    return parseJson(window.localStorage.getItem("morretes-delivery-item-reviewed"), []);
  }

  function markItemReviewed(orderId, itemId) {
    var key = orderId + ":" + itemId;
    var reviewed = getReviewedItemKeys();
    if (reviewed.indexOf(key) < 0) {
      reviewed.push(key);
      window.localStorage.setItem("morretes-delivery-item-reviewed", JSON.stringify(reviewed));
    }
  }

  // -- Cupons de desconto ---------------------------------------------------

  function validateCoupon(storeId, code, subtotal) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: storeId, code: code, subtotal: subtotal }),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            return { error: (result && result.error) || "Cupom invalido." };
          }
          return result;
        });
      })
      .catch(function () {
        return { error: "Não foi possível validar o cupom agora." };
      });
  }

  function listCoupons(storeId) {
    if (!window.fetch) {
      return Promise.resolve([]);
    }

    return window
      .fetch("/api/coupons?storeId=" + encodeURIComponent(storeId), {
        headers: getOwnerAuthHeaders(),
        cache: "no-store",
      })
      .then(function (response) {
        return response.ok ? response.json() : { coupons: [] };
      })
      .then(function (result) {
        return Array.isArray(result.coupons) ? result.coupons : [];
      })
      .catch(function () {
        return [];
      });
  }

  function saveCoupon(payload) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/coupons", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, getOwnerAuthHeaders()),
        body: JSON.stringify(payload),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            return { error: (result && result.error) || "Não foi possível salvar o cupom." };
          }
          return result;
        });
      })
      .catch(function () {
        return { error: "Não foi possível salvar o cupom agora." };
      });
  }

  function toggleCoupon(storeId, code) {
    if (!window.fetch) {
      return Promise.resolve({ error: "Sem conexão com o servidor." });
    }

    return window
      .fetch("/api/coupons/" + encodeURIComponent(code) + "/toggle", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, getOwnerAuthHeaders()),
        body: JSON.stringify({ storeId: storeId }),
      })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            return { error: (result && result.error) || "Não foi possível atualizar o cupom." };
          }
          return result;
        });
      })
      .catch(function () {
        return { error: "Não foi possível atualizar o cupom agora." };
      });
  }

  // -- Métricas de vendas (painel do lojista) --------------------------------

  function getOwnerMetrics(storeId) {
    if (!window.fetch) {
      return Promise.resolve({ salesByDay: [], topItems: [] });
    }

    return window
      .fetch("/api/orders/metrics?storeId=" + encodeURIComponent(storeId), {
        headers: getOwnerAuthHeaders(),
        cache: "no-store",
      })
      .then(function (response) {
        return response.ok ? response.json() : { salesByDay: [], topItems: [] };
      })
      .catch(function () {
        return { salesByDay: [], topItems: [] };
      });
  }

  // -- Pedir de novo ---------------------------------------------------------

  // Monta o carrinho a partir de um pedido antigo, pulando itens que não
  // existem mais (ou que foram desativados) na loja. Retorna quantos itens
  // entraram e quantos ficaram de fora.
  function buildCartFromOrder(order) {
    if (!order) {
      return { addedCount: 0, skippedCount: 0 };
    }

    var store = getStoreById(order.storeId);
    if (!store) {
      return { addedCount: 0, skippedCount: order.items.length };
    }

    var cart = { storeId: order.storeId, items: [] };
    var addedCount = 0;
    var skippedCount = 0;

    order.items.forEach(function (orderItem) {
      var storeItem = getItemById(store, orderItem.itemId);
      if (!storeItem || storeItem.available === false) {
        skippedCount += 1;
        return;
      }

      cart.items.push({ itemId: storeItem.id, quantity: orderItem.quantity });
      addedCount += 1;
    });

    if (addedCount > 0) {
      saveCart(cart);
    }

    return { addedCount: addedCount, skippedCount: skippedCount };
  }

  function getFavorites() {
    return parseJson(window.localStorage.getItem(favoritesKey), []);
  }

  function isFavorite(storeId) {
    return getFavorites().indexOf(storeId) >= 0;
  }

  function toggleFavorite(storeId) {
    var favorites = getFavorites();
    var existingIndex = favorites.indexOf(storeId);

    if (existingIndex >= 0) {
      favorites.splice(existingIndex, 1);
    } else {
      favorites.push(storeId);
    }

    window.localStorage.setItem(favoritesKey, JSON.stringify(favorites));
    return favorites;
  }

  function getOwnerSession() {
    return parseJson(window.localStorage.getItem(ownerSessionKey), null);
  }

  function saveOwnerSession(session) {
    window.localStorage.setItem(ownerSessionKey, JSON.stringify(session));
  }

  function clearOwnerSession() {
    window.localStorage.removeItem(ownerSessionKey);
  }

  function getCustomerSession() {
    return parseJson(window.localStorage.getItem(customerSessionKey), null);
  }

  function clearCustomerSession() {
    window.localStorage.removeItem(customerSessionKey);
  }

  // Guarda o id da corrida de táxi em aberto do cliente, pra ele conseguir
  // fechar o navegador/app e voltar depois sem perder o acompanhamento.
  var currentRideKey = "morretes-delivery-current-ride";

  function getCurrentRideId() {
    return window.localStorage.getItem(currentRideKey) || "";
  }

  function saveCurrentRideId(rideId) {
    window.localStorage.setItem(currentRideKey, rideId || "");
  }

  function clearCurrentRideId() {
    window.localStorage.removeItem(currentRideKey);
  }

  function getPartnerLeads() {
    return parseJson(window.localStorage.getItem(partnerLeadsKey), []);
  }

  function savePartnerLead(payload) {
    var leads = getPartnerLeads();
    var name = sanitizeText(payload && payload.name);
    var phone = sanitizeText(payload && payload.phone);
    var lead;

    if (!name || !phone) {
      return { error: "Preencha nome completo e número para contato." };
    }

    lead = {
      id: "lead-" + Date.now(),
      name: name,
      phone: phone,
      createdAt: new Date().toISOString(),
    };

    leads.unshift(lead);
    window.localStorage.setItem(partnerLeadsKey, JSON.stringify(leads));
    return { lead: lead };
  }

  // Login de lojista sempre passa pelo servidor (senha em hash, nunca em
  // texto puro no navegador). Retorna uma Promise com a sessão ou null.
  function loginOwnerOnServer(username, password) {
    if (!window.fetch) {
      return Promise.resolve(null);
    }

    return window
      .fetch("/api/auth/owner-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username, password: password }),
      })
      .then(function (response) {
        if (!response.ok) {
          return null;
        }
        return response.json();
      })
      .then(function (result) {
        if (!result || !result.owner || !result.token) {
          return null;
        }

        var session = {
          ownerId: result.owner.id,
          ownerName: result.owner.ownerName,
          storeId: result.owner.storeId,
          storeName: result.owner.storeName,
          username: result.owner.username,
          email: result.owner.email || "",
          token: result.token,
        };

        window.localStorage.setItem(ownerSessionKey, JSON.stringify(session));
        return session;
      })
      .catch(function () {
        return null;
      });
  }

  // Login de cliente também passa pelo servidor. O front só guarda os
  // dados públicos do cliente e um token de sessão - nunca a senha.
  function buildCustomerSessionFromServer(customer, token) {
    var address;
    var profile;

    if (!customer) {
      return null;
    }

    upsertLocalCustomer(customer);

    address = normalizeAddress(customer.address || {}, "address-home");
    profile = getProfile();
    saveProfile({
      name: customer.name || profile.name,
      cpf: customer.cpf || "",
      phone: customer.phone || profile.phone || "",
      addresses: [address],
      defaultAddressId: address.id,
    });

    var session = {
      customerId: customer.id,
      customerName: customer.name,
      email: customer.email,
      token: token || "",
    };

    window.localStorage.setItem(customerSessionKey, JSON.stringify(session));
    return session;
  }

  window.appDatabase = {
    load: load,
    save: save,
    syncCatalogFromServer: syncCatalogFromServer,
    getCategories: getCategories,
    getOwners: getOwners,
    getCustomers: getCustomers,
    getCustomerByEmail: getCustomerByEmail,
    syncCustomerFromServer: syncCustomerFromServer,
    buildCustomerSessionFromServer: buildCustomerSessionFromServer,
    getStoresByCategory: getStoresByCategory,
    getCategoryById: getCategoryById,
    getStoreById: getStoreById,
    getStoreSections: getStoreSections,
    createStore: createStore,
    upsertStore: upsertStore,
    deleteStore: deleteStore,
    saveStoreItems: saveStoreItems,
    upsertStoreItem: upsertStoreItem,
    pushStoreToServer: pushStoreToServer,
    pushStoreItemToServer: pushStoreItemToServer,
    searchStores: searchStores,
    searchCatalog: searchCatalog,
    getCart: getCart,
    getCartDetailed: getCartDetailed,
    addItemToCart: addItemToCart,
    updateCartItemQuantity: updateCartItemQuantity,
    removeCartItem: removeCartItem,
    clearCart: clearCart,
    getOrders: getOrders,
    getOrdersByStore: getOrdersByStore,
    getOrderById: getOrderById,
    clearOrdersByStore: clearOrdersByStore,
    updateOrderStatus: updateOrderStatus,
    refundOrder: refundOrder,
    syncOrderPayment: syncOrderPayment,
    cancelOrderByCustomer: cancelOrderByCustomer,
    updateOrderPrepEstimate: updateOrderPrepEstimate,
    syncOwnerOrdersFromServer: syncOwnerOrdersFromServer,
    refreshCustomerOrdersFromServer: refreshCustomerOrdersFromServer,
    getNewOrdersCountByStore: getNewOrdersCountByStore,
    placeOrder: placeOrder,
    getProfile: getProfile,
    saveProfile: saveProfile,
    getCurrentAddress: getCurrentAddress,
    isStoreOpen: isStoreOpen,
    getDeliveryFeeForStore: getDeliveryFeeForStore,
    getDeliveryFeeLabelForStore: getDeliveryFeeLabelForStore,
    getItemDisplayPrice: getItemDisplayPrice,
    getFavorites: getFavorites,
    isFavorite: isFavorite,
    toggleFavorite: toggleFavorite,
    submitReview: submitReview,
    getStoreReviews: getStoreReviews,
    getStoreReviewsForModeration: getStoreReviewsForModeration,
    setReviewVisibility: setReviewVisibility,
    setItemReviewVisibility: setItemReviewVisibility,
    getReviewedOrderIds: getReviewedOrderIds,
    markOrderReviewed: markOrderReviewed,
    submitItemReview: submitItemReview,
    getItemReviews: getItemReviews,
    getReviewedItemKeys: getReviewedItemKeys,
    markItemReviewed: markItemReviewed,
    validateCoupon: validateCoupon,
    listCoupons: listCoupons,
    saveCoupon: saveCoupon,
    toggleCoupon: toggleCoupon,
    getOwnerMetrics: getOwnerMetrics,
    buildCartFromOrder: buildCartFromOrder,
    getOwnerSession: getOwnerSession,
    saveOwnerSession: saveOwnerSession,
    loginOwnerOnServer: loginOwnerOnServer,
    getOwnerAuthHeaders: getOwnerAuthHeaders,
    updateOwnerEmail: updateOwnerEmail,
    uploadItemPhoto: uploadItemPhoto,
    connectOwnerOrdersSocket: connectOwnerOrdersSocket,
    connectTaxiDriverSocket: connectTaxiDriverSocket,
    connectRideSocket: connectRideSocket,
    clearOwnerSession: clearOwnerSession,
    getCustomerSession: getCustomerSession,
    clearCustomerSession: clearCustomerSession,
    getCurrentRideId: getCurrentRideId,
    saveCurrentRideId: saveCurrentRideId,
    clearCurrentRideId: clearCurrentRideId,
    getPartnerLeads: getPartnerLeads,
    savePartnerLead: savePartnerLead,
    formatMoney: formatMoney,
    formatAddress: formatAddress,
    escapeHtml: escapeHtml,
    sanitizeUrl: sanitizeUrl,
    reset: function reset() {
      save(clone(defaultData));
      clearCart();
      saveOrders([]);
      saveProfile(clone(defaultProfile));
      window.localStorage.setItem(favoritesKey, JSON.stringify([]));
      window.localStorage.removeItem("morretes-delivery-reviewed");
      clearOwnerSession();
      clearCustomerSession();
    },
  };
})();
  function getItemDisplayPrice(item) {
    var basePrice = Number(item && item.price ? item.price : 0);
    var promoPrice = item && item.promoPrice != null ? Number(item.promoPrice) : null;

    if (promoPrice != null && promoPrice > 0 && promoPrice < basePrice) {
      return promoPrice;
    }

    return basePrice;
  }
