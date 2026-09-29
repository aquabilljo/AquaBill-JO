/* ==========================================================================
   AquaBill JO — حاسبة فاتورة المياه الأردنية — ملف المنطق (JavaScript)
   ------------------------------------------------------------------------
   يعتمد هذا الملف على الكائن APP_CONFIG المُعرَّف بملف config.js (يجب أن
   يُحمَّل قبل هذا الملف بـ index.html).

   الوحدات المنطقية بهذا الملف:
     1. ERROR LOGGING     → تسجيل أخطاء العميل محلياً دون أي خادم خارجي
     2. STORAGE            → طبقة موحّدة للقراءة/الكتابة بالتخزين المحلي
     3. VALIDATION         → التحقق من صحة مدخلات المستخدم
     4. CALCULATION ENGINE → دوال حساب الفاتورة
     5. THEME TOGGLE       → التبديل اليدوي بين الوضع الفاتح والداكن
     6. SCROLL EFFECTS     → شريط التقدم والظهور التدريجي للبطاقات
     7. SERVICE WORKER     → تسجيل العمل بدون إنترنت (PWA)
     8. SHARE FEATURE      → مشاركة الأداة وتوليد QR عالي الدقة (HD)
     9. PWA INSTALL PROMPT → إشعار "تثبيت التطبيق" على الهاتف
     10. INITIALIZATION    → التشغيل الأولي عند تحميل الصفحة
   ========================================================================== */

'use strict';

const tiers = APP_CONFIG.tiers.map((t) => ({ ...t }));
let deferredInstallPrompt = null;

/* ==========================================================================
   1. ERROR LOGGING — تسجيل أخطاء العميل محلياً
   ========================================================================== */

const MAX_LOG_ENTRIES = 20;

function logClientError(message, context) {
  try {
    const key = APP_CONFIG.storageKeys.errorLog;
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    existing.push({
      message: String(message),
      context: context || 'unknown',
      time: new Date().toISOString(),
      version: APP_CONFIG.version,
    });
    const trimmed = existing.slice(-MAX_LOG_ENTRIES);
    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch (e) {
    // يتجاهل الأخطاء بصمت
  }
}

window.addEventListener('error', (e) => {
  logClientError(e.message, e.filename ? `${e.filename}:${e.lineno}` : 'global');
});


/* ==========================================================================
   2. STORAGE — طبقة موحّدة للتخزين المحلي
   ========================================================================== */

const DEFAULT_SETTINGS = {
  theme: null,
  tariffOverride: null,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(APP_CONFIG.storageKeys.settings);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    logClientError(e.message, 'loadSettings');
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(APP_CONFIG.storageKeys.settings, JSON.stringify(settings));
  } catch (e) {
    logClientError(e.message, 'saveSettings');
  }
}

function updateSetting(key, value) {
  const settings = loadSettings();
  settings[key] = value;
  saveSettings(settings);
}


/* ==========================================================================
   3. VALIDATION — التحقق من صحة مدخلات المستخدم
   ========================================================================== */

function sanitizeNumber(value, fallback = 0) {
  const n = parseFloat(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n < 0) return fallback;
  return n;
}


/* ==========================================================================
   4. CALCULATION ENGINE — دوال حساب الفاتورة
   ========================================================================== */

function costFor(n, field) {
  let cost = 0;
  let prevCap = 0;

  for (const t of tiers) {
    const cap = t.upTo;

    if (t.flat) {
      cost += t[field];
      prevCap = cap;
      if (n <= cap) break;
      continue;
    }

    if (n > prevCap) {
      const units = Math.min(n, cap) - prevCap;
      cost += units * t[field];
    }
    prevCap = cap;
    if (n <= cap) break;
  }

  return cost;
}

function calcAll() {
  const consumptionInput = document.getElementById('consumption');
  const tankerCapInput = document.getElementById('tankerQty');
  const tankerPriceInput = document.getElementById('tankerPrice');

  [consumptionInput, tankerCapInput, tankerPriceInput].forEach(input => {
    if (input && input.value) {
      if (input.value.includes('-')) {
        input.value = input.value.replace(/-/g, '');
      }
      if (input.value.length > 3) {
        input.value = input.value.slice(0, 3);
      }
    }
  });

  const rawInput = consumptionInput ? consumptionInput.value.trim() : '';

  if (rawInput === '') {
    document.getElementById('waterOut').textContent = '0.00';
    document.getElementById('sewageOut').textContent = '0.00';
    document.getElementById('totalOut').textContent = '0.00';

    const flatFeeHint = document.getElementById('flatFeeHint');
    if (flatFeeHint) flatFeeHint.style.display = 'none';

    document.getElementById('marginalHint').textContent = 'أدخل كمية الاستهلاك لمعرفة تكلفة المتر القادم.';

    const badge = document.getElementById('statusBadge');
    if (badge) badge.innerHTML = '';

    document.getElementById('networkMarginal').textContent = '0.00';
    document.getElementById('tankerMarginal').textContent = '0.00';
    return;
  }

  const consumptionVal = parseFloat(rawInput);

  if (isNaN(consumptionVal) || consumptionVal < 0 || consumptionVal > 500) {
    document.getElementById('waterOut').textContent = '0.00';
    document.getElementById('sewageOut').textContent = '0.00';
    document.getElementById('totalOut').textContent = '0.00';

    const flatFeeHint = document.getElementById('flatFeeHint');
    if (flatFeeHint) flatFeeHint.style.display = 'none';

    document.getElementById('marginalHint').textContent = 'القيمة المدخلة غير صحيحة أو تتجاوز النطاق المسموح (500 م³).';

    const badge = document.getElementById('statusBadge');
    if (badge) badge.innerHTML = '';

    document.getElementById('networkMarginal').textContent = '0.00';
    document.getElementById('tankerMarginal').textContent = '0.00';
    return;
  }

  const n = Math.max(0, sanitizeNumber(rawInput, 0));
  const water = costFor(n, 'water');
  const sewage = costFor(n, 'sewage');
  const total = water + sewage;

  document.getElementById('waterOut').textContent = `${water.toFixed(2)} ${APP_CONFIG.currencyLabelAr}`;
  document.getElementById('sewageOut').textContent = `${sewage.toFixed(2)} ${APP_CONFIG.currencyLabelAr}`;
  document.getElementById('totalOut').textContent = `${total.toFixed(2)} ${APP_CONFIG.currencyLabelAr}`;

  const flatFeeHint = document.getElementById('flatFeeHint');
  if (flatFeeHint) {
    flatFeeHint.style.display = (n <= 6) ? 'inline-block' : 'none';
  }

  const nextWater = costFor(n + 1, 'water') - water;
  const nextSewage = costFor(n + 1, 'sewage') - sewage;
  const marginal = Math.max(0, nextWater + nextSewage);

  document.getElementById('marginalHint').textContent =
    `المتر القادم (رقم ${Math.ceil(n) + 1}) سيكلفك تقريباً ${marginal.toFixed(2)} ${APP_CONFIG.currencyLabelAr} إضافي.`;

  const badge = document.getElementById('statusBadge');
  if (badge) {
    let newHTML = '';
    if (n <= 6) {
      newHTML = '<span class="badge ok">💧 شريحة المقطوعية - استهلاك منزلي ممتاز</span>';
    } else if (n <= 12) {
      newHTML = '<span class="badge ok">🌿 استهلاك منزلي جيد جداً</span>';
    } else if (n <= 18) {
      newHTML = '<span class="badge ok">⚖️ استهلاك منزلي معتدل</span>';
    } else if (n <= 24) {
      newHTML = '<span class="badge warn">⚠️ استهلاك متوسط-مرتفع - تحقق من السبب</span>';
    } else if (n <= 50) {
      newHTML = '<span class="badge bad">🚨 استهلاك مرتفع - راجع التسريبات وأسباب الزيادة</span>';
    } else {
      newHTML = '<span class="badge critical">💥 تحذير: استهلاك مرتفع جداً! افحص العداد والتسريبات فوراً</span>';
    }
    badge.innerHTML = newHTML;
  }

  document.getElementById('networkMarginal').textContent = `${marginal.toFixed(2)} ${APP_CONFIG.currencyLabelAr}`;

  const rawTankerPrice = parseFloat(tankerPriceInput?.value) || 0;
  const rawTankerQty = parseFloat(tankerCapInput?.value) || 0;

  const tankerPrice = Math.max(0, rawTankerPrice);
  const tankerQty = Math.max(0, rawTankerQty);

  const boxNetwork = document.getElementById('boxNetwork');
  const boxTanker = document.getElementById('boxTanker');
  const recommendHint = document.getElementById('recommendHint');

  if (tankerPrice > 500 || tankerQty > 100) {
    document.getElementById('tankerMarginal').textContent = '-';
    boxNetwork?.classList.remove('win');
    boxTanker?.classList.remove('win');
    if (recommendHint) {
      recommendHint.textContent = '⚠️ السعر أو السعة المدخلة للصهريج غير منطقية (الأقصى: 100 م³ سعة / 500 د.أ سعر).';
    }
    return;
  }

  const tankerPerM3 = (tankerPrice > 0 && tankerQty > 0) ? (tankerPrice / tankerQty) : 0;

  document.getElementById('tankerMarginal').textContent = tankerPerM3 > 0 
    ? `${tankerPerM3.toFixed(2)} ${APP_CONFIG.currencyLabelAr}` 
    : `0.00 ${APP_CONFIG.currencyLabelAr}`;

  if (tankerPerM3 > 0) {
    if (marginal < tankerPerM3) {
      boxNetwork?.classList.add('win');
      boxTanker?.classList.remove('win');
      if (recommendHint) recommendHint.textContent = 'الأوفر: سحب المتر الإضافي من العداد بدل طلب صهريج مياه.';
    } else {
      boxTanker?.classList.add('win');
      boxNetwork?.classList.remove('win');
      if (recommendHint) recommendHint.textContent = 'الأوفر هنا: صهريج المياه أرخص من تجاوز الشريحة الحالية.';
    }
  } else {
    boxNetwork?.classList.remove('win');
    boxTanker?.classList.remove('win');
    if (recommendHint) recommendHint.textContent = 'أدخل سعر وسعة الصهريج للمقارنة مع العداد.';
  }
}

(function initConsumptionWarning() {
  const input = document.getElementById('consumption');
  const badge = document.getElementById('consumption-warning');

  if (input && badge) {
    input.addEventListener('input', function () {
      const val = parseFloat(this.value);
      badge.style.display = (val > 500) ? 'block' : 'none';
    });
  }
})();


/* ==========================================================================
   5. THEME TOGGLE — التبديل بين الوضع الفاتح والداكن
   ========================================================================== */

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
  document.documentElement.setAttribute('data-theme', newTheme);
  updateSetting('theme', newTheme);  
  
  const themeBtn = document.querySelector('.btn-theme-toggle') || document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.textContent = newTheme === 'dark' ? '🌞' : '🌙';
    themeBtn.setAttribute('aria-pressed', String(newTheme === 'dark'));
  }
}


/* ==========================================================================
   6. SCROLL EFFECTS — شريط التقدم والظهور التدريجي
   ========================================================================== */

function initScrollProgress() {
  const bar = document.getElementById('scrollProgress');
  if (!bar) return;

  let ticking = false;
  function update() {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    ticking = false;
  }
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });
  update();
}

function initFadeInCards() {
  const cards = document.querySelectorAll('.fade-in');
  if (!cards.length) return;

  if (!('IntersectionObserver' in window)) return;

  cards.forEach((c) => c.classList.add('fade-init'));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  cards.forEach((c) => observer.observe(c));
}


/* ==========================================================================
   7. SERVICE WORKER — تسجيل العمل بدون إنترنت (PWA)
   ========================================================================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .catch((err) => {
        console.warn('تعذر تسجيل Service Worker:', err);
        if (typeof logClientError === 'function') {
          logClientError(err.message || String(err), 'serviceWorker.register');
        }
      });
  });
}


/* ==========================================================================
   8. SHARE FEATURE — مشاركة الأداة وتوليد الـ QR عالي الدقة (HD)
   ========================================================================== */

function initShareLogic() {
  const shareBtn = document.getElementById('shareBtn');
  const shareFallback = document.getElementById('shareFallback');
  const shareWhatsApp = document.getElementById('shareWhatsApp');
  const shareFacebook = document.getElementById('shareFacebook');
  const copyShareLink = document.getElementById('copyShareLink');
  const shareQRBtn = document.getElementById('shareQRBtn');
  const miniQrBadge = document.getElementById('miniQrBadge');
  const qrModal = document.getElementById('qrModal');
  const closeQrBtn = document.getElementById('closeQrBtn');
  const qrContainer = document.getElementById('qrContainer');
  const downloadQRBtn = document.getElementById('downloadQRBtn');

  if (!shareBtn || !shareFallback) return;

  let currentTriggerElement = null;

  const cleanUrl = `${window.location.origin}${window.location.pathname}`;

  const shareData = {
    title: 'AquaBill JO — حاسبة فاتورة المياه الأردنية',
    text: 'قدّر تكلفة استهلاكك الشهري للمياه بسهولة مع AquaBill JO.',
    url: cleanUrl
  };

  const logoImg = new Image();
  logoImg.src = 'images/qr-logo.png';

  /* تعريف دالة الإغلاق في بداية النطاق لتفادي أخطاء ReferenceError */
  function closeQrModal() {
    if (!qrModal) return;
    qrModal.hidden = true;
    document.body.style.overflow = '';

    if (currentTriggerElement && typeof currentTriggerElement.focus === 'function') {
      currentTriggerElement.focus();
    } else if (shareQRBtn) {
      shareQRBtn.focus();
    }
  }

  /* تموضع وإغلاق/فتح قائمة المشاركة */
  const positionShareFallback = () => {
    if (shareFallback.hidden) return;

    const buttonRect = shareBtn.getBoundingClientRect();
    const menuRect = shareFallback.getBoundingClientRect();
    const gap = 10;
    const screenPadding = 16;

    const spaceBelow = window.innerHeight - buttonRect.bottom - gap;
    const spaceAbove = buttonRect.top - gap;

    let top = (spaceBelow >= menuRect.height || spaceBelow >= spaceAbove)
      ? buttonRect.bottom + gap
      : buttonRect.top - menuRect.height - gap;

    top = Math.max(screenPadding, Math.min(top, window.innerHeight - menuRect.height - screenPadding));

    let left = buttonRect.left + (buttonRect.width - menuRect.width) / 2;
    left = Math.max(screenPadding, Math.min(left, window.innerWidth - menuRect.width - screenPadding));

    shareFallback.style.top = `${top}px`;
    shareFallback.style.left = `${left}px`;
  };

  const closeShareFallback = () => {
    shareFallback.hidden = true;
    shareBtn.setAttribute('aria-expanded', 'false');
    shareFallback.style.top = '';
    shareFallback.style.left = '';
  };

  const openShareFallback = () => {
    shareFallback.hidden = false;
    shareBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(positionShareFallback);
  };

  shareBtn.addEventListener('click', () => {
    if (shareFallback.hidden) {
      openShareFallback();
    } else {
      closeShareFallback();
    }
  });

  /* روابط WhatsApp & Facebook */
  if (shareWhatsApp) {
    shareWhatsApp.href = `https://api.whatsapp.com/send?text=${encodeURIComponent(`${shareData.text}${shareData.url}`)}`;
  }

  if (shareFacebook) {
    shareFacebook.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareData.url)}`;
  }

  /* نسخ الرابط مع تحويل الأيقونة لشارة صح خضراء */
  if (copyShareLink) {
    copyShareLink.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shareData.url);
        const copyText = document.getElementById('copyText');
        const copyIcon = document.getElementById('copyIcon');

        if (copyText) copyText.textContent = 'تم نسخ الرابط!';
        if (copyIcon) {
          copyIcon.outerHTML = `<svg id="copyIcon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        }

        setTimeout(() => {
          if (copyText) copyText.textContent = 'نسخ الرابط';
          const currentIcon = document.getElementById('copyIcon');
          if (currentIcon) {
            currentIcon.outerHTML = `<svg id="copyIcon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
          }
        }, 2000);
      } catch {
        closeShareFallback();
      }
    });
  }

  /* فتح نافذة الـ QR وقفل التمرير ورسم الرمز واللوجو بأبعاد متناسقة */
  function openQrModal(titleText, hintText, triggerBtn) {
    if (!qrModal || !qrContainer) return;

    currentTriggerElement = triggerBtn || shareQRBtn;

    if (typeof hideInstallToast === 'function') {
      hideInstallToast();
    }

    document.body.style.overflow = 'hidden';

    const modalTitle = qrModal.querySelector('h3');
    const modalHint = qrModal.querySelector('.qr-hint');

    if (modalTitle && titleText) modalTitle.textContent = titleText;
    if (modalHint && hintText) modalHint.textContent = hintText;

    closeShareFallback();
    qrModal.hidden = false;
    if (closeQrBtn) closeQrBtn.focus();

    qrContainer.innerHTML = '';

    if (typeof QRCode !== 'undefined') {
      const hdSize = 800;

      new QRCode(qrContainer, {
        text: shareData.url,
        width: hdSize,
        height: hdSize,
        correctLevel: QRCode.CorrectLevel.H
      });

      const renderHDQR = () => {
        const qrCanvas = qrContainer.querySelector('canvas');
        const img = qrContainer.querySelector('img');

        if (!qrCanvas) {
          setTimeout(renderHDQR, 40);
          return;
        }

        const applyHDEnhancements = () => {
          try {
            const extraHeight = 110;
            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = hdSize;
            finalCanvas.height = hdSize + extraHeight;
            const ctx = finalCanvas.getContext('2d');

            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

            ctx.drawImage(qrCanvas, 0, 0, hdSize, hdSize);

            if (logoImg.complete && logoImg.naturalWidth !== 0) {
              const logoBoxSize = 170;
              const logoImgSize = 150;
              const boxX = (hdSize - logoBoxSize) / 2;
              const boxY = (hdSize - logoBoxSize) / 2;
              const logoX = (hdSize - logoImgSize) / 2;
              const logoY = (hdSize - logoImgSize) / 2;

              ctx.fillStyle = '#ffffff';
              ctx.beginPath();
              if (ctx.roundRect) {
                ctx.roundRect(boxX, boxY, logoBoxSize, logoBoxSize, 20);
              } else {
                ctx.fillRect(boxX, boxY, logoBoxSize, logoBoxSize);
              }
              ctx.fill();

              ctx.drawImage(logoImg, logoX, logoY, logoImgSize, logoImgSize);
            }

            ctx.direction = 'ltr';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            const centerX = hdSize / 2;

            ctx.font = 'bold 26px "Tajawal", system-ui, -apple-system, sans-serif';
            ctx.fillStyle = '#0f172a';
            ctx.fillText('حاسبة المياه الأردنية — AquaBill JO', centerX, hdSize + 36);

            ctx.font = '600 18px "Tajawal", system-ui, -apple-system, sans-serif';
            ctx.fillStyle = '#475569';
            ctx.fillText('أداة مستقلة غير تابعة لأي جهة حكومية أو لسلطة المياه', centerX, hdSize + 76);

            const finalImageData = finalCanvas.toDataURL('image/png', 1.0);

if (img) {
  img.src = finalImageData;
  /* اعتمدنا على الأبعاد المحجوزة مسبقاً في style.css لمنع قفزة القياس */
       }

            qrCanvas.style.display = 'none';
            qrContainer.dataset.downloadUrl = finalImageData;

          } catch (e) {
            console.warn('تنبيه معالجة الـ QR:', e);
          }
        };

        if (logoImg.complete) {
          applyHDEnhancements();
        } else {
          logoImg.onload = applyHDEnhancements;
          logoImg.onerror = applyHDEnhancements;
        }
      };

      renderHDQR();
    }
  }

  /* ربط أزرار فتح الـ QR */
  if (shareQRBtn) {
    shareQRBtn.addEventListener('click', () => {
      openQrModal(
        'شارك حاسبة المياه مع عائلتك وأصدقائك',
        'امسح الرمز بكاميرا الهاتف أو نزّل الصورة لمشاركتها بسهولة.',
        shareQRBtn
      );
    });
  }

  if (miniQrBadge) {
    miniQrBadge.addEventListener('click', () => {
      openQrModal(
        'افتح الأداة وتابع الحساب من هاتفك الذكي',
        'وجّه كاميرا هاتفك نحو الرمز لفتح حاسبة المياه وتثبيتها فوراً.',
        miniQrBadge
      );
    });
  }

  /* أحداث إغلاق النافذة المنبثقة */
  if (closeQrBtn && qrModal) {
    closeQrBtn.addEventListener('click', closeQrModal);

    qrModal.addEventListener('click', (event) => {
      if (event.target === qrModal) {
        closeQrModal();
      }
    });
  }

  /* تنزيل صورة الـ QR المكتملة */
  if (downloadQRBtn && qrContainer) {
    downloadQRBtn.addEventListener('click', () => {
      const imageSrc = qrContainer.dataset.downloadUrl || 
                       qrContainer.querySelector('img')?.src;

      if (imageSrc) {
        const link = document.createElement('a');
        link.href = imageSrc;
        link.download = 'AquaBill-JO-QR.png';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    });
  }

  /* إغلاق عند الضغط خارجاً أو زر Escape */
  document.addEventListener('click', (event) => {
    if (!shareFallback.hidden && !shareFallback.contains(event.target) && !shareBtn.contains(event.target)) {
      closeShareFallback();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;

    if (qrModal && !qrModal.hidden) {
      closeQrModal();
      return;
    }

    if (!shareFallback.hidden) {
      closeShareFallback();
      shareBtn.focus();
    }
  });

  window.addEventListener('resize', () => {
    if (!shareFallback.hidden) {
      closeShareFallback();
    }
  });

  window.addEventListener('scroll', () => {
    if (!shareFallback.hidden) {
      closeShareFallback();
    }
  }, { passive: true });
}


/* ==========================================================================
   9. PWA INSTALL PROMPT — إشعار "تثبيت التطبيق" الانسيابي المطور
   ========================================================================== */

let isDismissedByUser = false;
let installToastTimer = null;
let isTimerPassed = false;
let lastScrollY = window.scrollY;

function isNearPageBottom() {
    const scrollPosition = window.scrollY + window.innerHeight;
    const pageHeight = document.documentElement.scrollHeight;
    return scrollPosition >= pageHeight - 180;
}

function isShareMenuOpen() {
    const shareFallback = document.getElementById('shareFallback');
    return shareFallback && !shareFallback.hidden;
}

function isQrModalOpen() {
    const qrModal = document.getElementById('qrModal');
    return qrModal && !qrModal.hidden;
}

function isInputFocused() {
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
}

function showInstallToast() {
    const toast = document.getElementById('pwaToast');

    if (
        !toast ||
        isDismissedByUser ||
        !deferredInstallPrompt ||
        !isTimerPassed ||
        isNearPageBottom() ||
        isShareMenuOpen() ||
        isQrModalOpen() ||
        isInputFocused()
    ) {
        return;
    }

    if (toast.classList.contains('show')) return;

    toast.hidden = false;
    void toast.offsetWidth;
    toast.classList.add('show');
}

function hideInstallToast() {
    const toast = document.getElementById('pwaToast');
    if (!toast || !toast.classList.contains('show')) return;

    toast.classList.remove('show');
    setTimeout(() => {
        if (!toast.classList.contains('show')) {
            toast.hidden = true;
        }
    }, 400);
}

function dismissInstallToast() {
    isDismissedByUser = true;

    if (installToastTimer) {
        window.clearTimeout(installToastTimer);
        installToastTimer = null;
    }

    hideInstallToast();
}

function installApp() {
    hideInstallToast();
    if (!deferredInstallPrompt) return;

    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.finally(() => {
        deferredInstallPrompt = null;
    });
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;

    if (installToastTimer) {
        window.clearTimeout(installToastTimer);
    }

    installToastTimer = window.setTimeout(() => {
        isTimerPassed = true;

        if (isDismissedByUser) return;

        if (!isShareMenuOpen() && !isQrModalOpen() && !isNearPageBottom() && !isInputFocused()) {
            showInstallToast();
        }
    }, 7000);
});

/* التمرير الذكي */
window.addEventListener('scroll', () => {
    if (isDismissedByUser || !isTimerPassed) return;

    const currentScrollY = window.scrollY;
    if (Math.abs(currentScrollY - lastScrollY) < 6) return;

    const isScrollingDown = currentScrollY > lastScrollY && currentScrollY > 50;

    if (isNearPageBottom() || isShareMenuOpen() || isQrModalOpen() || isInputFocused() || isScrollingDown) {
        hideInstallToast();
    } else {
        if (deferredInstallPrompt) {
            showInstallToast();
        }
    }

    lastScrollY = currentScrollY;
}, { passive: true });

document.addEventListener('focusin', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
        hideInstallToast();
    }
});

document.addEventListener('focusout', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
        if (isTimerPassed && !isQrModalOpen()) {
            setTimeout(showInstallToast, 300);
        }
    }
});

window.addEventListener('appinstalled', () => {
    isDismissedByUser = true;
    hideInstallToast();
    deferredInstallPrompt = null;
});

function initPwaToastEvents() {
    const pwaToast = document.getElementById('pwaToast');
    if (pwaToast) {
        const buttons = pwaToast.querySelectorAll('button');

        if (buttons.length >= 1) {
            buttons[0].addEventListener('click', installApp);
            buttons[0].removeAttribute('onclick');
        }

        if (buttons.length >= 2) {
            buttons[1].addEventListener('click', dismissInstallToast);
            buttons[1].removeAttribute('onclick');
        }
    }
}

window.dismissInstallToast = dismissInstallToast;
window.installApp = installApp;


/* ==========================================================================
   10. INITIALIZATION — التشغيل الأولي عند تحميل الصفحة
   ========================================================================== */

function initApp() {
    const settings = loadSettings();
    if (Array.isArray(settings.tariffOverride) && settings.tariffOverride.length === tiers.length) {
        settings.tariffOverride.forEach((t, i) => {
            tiers[i].water = sanitizeNumber(t.water, tiers[i].water);
            tiers[i].sewage = sanitizeNumber(t.sewage, tiers[i].sewage);
        });
    }

    if (settings.theme) {
        document.documentElement.setAttribute('data-theme', settings.theme);
    }

    initScrollProgress();
    initFadeInCards();
    initShareLogic();
    initPwaToastEvents();

    const themeToggleBtn = document.getElementById('themeToggle');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', toggleTheme);
    }

    const consumptionInput = document.getElementById('consumption');
    if (consumptionInput) {
        consumptionInput.addEventListener('input', calcAll);
    }

    const tankerQtyInput = document.getElementById('tankerQty');
    if (tankerQtyInput) {
        tankerQtyInput.addEventListener('input', calcAll);
    }

    const tankerPriceInput = document.getElementById('tankerPrice');
    if (tankerPriceInput) {
        tankerPriceInput.addEventListener('input', calcAll);
    }

    if (themeToggleBtn) {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isDarkNow = currentTheme ? currentTheme === 'dark' : systemPrefersDark;
        themeToggleBtn.setAttribute('aria-pressed', String(isDarkNow));
    }

    const versionEl = document.getElementById('appVersion');
    if (versionEl) {
        versionEl.textContent = `${APP_CONFIG.appName} — الإصدار ${APP_CONFIG.version}`;
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
