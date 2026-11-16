/**
 * LocalShare - DPDP Act 2023 & Legal Compliance Controller
 * Handles India DPDP Act 2023 notice, unbundled consent, and legal modal dialogs.
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  const STORAGE_KEY = 'localshare_dpdp_consent';

  function initConsent() {
    const banner = document.getElementById('consentBanner');
    const btnAccept = document.getElementById('btnConsentAccept');
    const btnEssential = document.getElementById('btnConsentEssential');
    const btnPrefs = document.getElementById('btnConsentPrefs');

    const privacyModal = document.getElementById('privacyModal');
    const termsModal = document.getElementById('termsModal');
    const cookiePrefsModal = document.getElementById('cookiePrefsModal');

    const btnOpenPrivacy = document.getElementById('btnOpenPrivacy');
    const btnOpenTerms = document.getElementById('btnOpenTerms');
    const btnOpenCookiePrefs = document.getElementById('btnOpenCookiePrefs');

    const btnClosePrivacy = document.getElementById('btnClosePrivacy');
    const btnCloseTerms = document.getElementById('btnCloseTerms');
    const btnCloseCookiePrefs = document.getElementById('btnCloseCookiePrefs');
    const btnSaveCookiePrefs = document.getElementById('btnSaveCookiePrefs');

    // Check existing consent
    const existing = localStorage.getItem(STORAGE_KEY);
    if (!existing && banner) {
      banner.style.display = 'flex';
    }

    if (btnAccept && banner) {
      btnAccept.addEventListener('click', () => {
        saveConsent({ essential: true, analytics: true, marketing: true });
        banner.style.display = 'none';
        if (window.LS.ui) window.LS.ui.showToast('Preferences saved (DPDP Act 2023)');
      });
    }

    if (btnEssential && banner) {
      btnEssential.addEventListener('click', () => {
        saveConsent({ essential: true, analytics: false, marketing: false });
        banner.style.display = 'none';
        if (window.LS.ui) window.LS.ui.showToast('Essential cookies only enabled');
      });
    }

    if (btnPrefs && cookiePrefsModal) {
      btnPrefs.addEventListener('click', () => {
        cookiePrefsModal.style.display = 'flex';
      });
    }

    // Footer Triggers
    if (btnOpenPrivacy && privacyModal) {
      btnOpenPrivacy.addEventListener('click', () => {
        privacyModal.style.display = 'flex';
      });
    }

    if (btnOpenTerms && termsModal) {
      btnOpenTerms.addEventListener('click', () => {
        termsModal.style.display = 'flex';
      });
    }

    if (btnOpenCookiePrefs && cookiePrefsModal) {
      btnOpenCookiePrefs.addEventListener('click', () => {
        cookiePrefsModal.style.display = 'flex';
      });
    }

    // Modal Close Triggers
    if (btnClosePrivacy && privacyModal) {
      btnClosePrivacy.addEventListener('click', () => {
        privacyModal.style.display = 'none';
      });
    }

    if (btnCloseTerms && termsModal) {
      btnCloseTerms.addEventListener('click', () => {
        termsModal.style.display = 'none';
      });
    }

    if (btnCloseCookiePrefs && cookiePrefsModal) {
      btnCloseCookiePrefs.addEventListener('click', () => {
        cookiePrefsModal.style.display = 'none';
      });
    }

    if (btnSaveCookiePrefs && cookiePrefsModal) {
      btnSaveCookiePrefs.addEventListener('click', () => {
        const analyticsAllowed = document.getElementById('chkAnalytics')?.checked ?? false;
        saveConsent({ essential: true, analytics: analyticsAllowed, marketing: false });
        cookiePrefsModal.style.display = 'none';
        if (banner) banner.style.display = 'none';
        if (window.LS.ui) window.LS.ui.showToast('Cookie preferences updated');
      });
    }

    // Close on outside overlay click
    [privacyModal, termsModal, cookiePrefsModal].forEach(modal => {
      if (modal) {
        modal.addEventListener('click', e => {
          if (e.target === modal) modal.style.display = 'none';
        });
      }
    });
  }

  function saveConsent(prefs) {
    const data = {
      ...prefs,
      timestamp: Date.now(),
      version: '1.0-dpdp-2023'
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  window.LS.consent = {
    init: initConsent,
    saveConsent
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsent);
  } else {
    initConsent();
  }

})(window);
