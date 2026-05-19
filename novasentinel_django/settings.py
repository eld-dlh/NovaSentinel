"""
NovaSentinel Django Settings
MVT-pattern backend that proxies Space-Track / CelesTrak APIs, stores audit
logs in PostgreSQL, and serves the Three.js dashboard as a Django template.

Environment variables (create a .env file or export these):
    SECRET_KEY               — Django secret key
    DEBUG                    — 'True' or 'False' (default True in dev)
    ALLOWED_HOSTS            — comma-separated hostnames
    SPACETRACK_IDENTITY      — Space-Track account email
    SPACETRACK_PASSWORD      — Space-Track account password
    DATABASE_URL             — postgres://user:pass@host:port/dbname
                               (falls back to SQLite when not set)
"""

import os
from pathlib import Path

# ── Base directory ──────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent

# ── Security ────────────────────────────────────────────────────────────────
SECRET_KEY = os.environ.get(
    'SECRET_KEY',
    'django-insecure-novasentinel-dev-key-change-in-production-abc123xyz'
)

DEBUG = os.environ.get('DEBUG', 'True') == 'True'

ALLOWED_HOSTS = os.environ.get('ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',')

# ── Application definition ──────────────────────────────────────────────────
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'corsheaders',
    'dashboard',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',          # must be before CommonMiddleware
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'novasentinel_django.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        # Look for templates inside each app's templates/ folder
        'DIRS': [BASE_DIR / 'dashboard' / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'novasentinel_django.wsgi.application'

# ── Database ─────────────────────────────────────────────────────────────────
# Uses PostgreSQL when DATABASE_URL is set; falls back to SQLite for local dev.

_database_url = os.environ.get('DATABASE_URL', '')

if _database_url.startswith('postgres'):
    import urllib.parse as _up
    _u = _up.urlparse(_database_url)
    DATABASES = {
        'default': {
            'ENGINE':   'django.db.backends.postgresql',
            'NAME':     _u.path.lstrip('/'),
            'USER':     _u.username,
            'PASSWORD': _u.password,
            'HOST':     _u.hostname,
            'PORT':     str(_u.port or 5432),
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME':   BASE_DIR / 'db.sqlite3',
        }
    }

# ── Space-Track credentials ───────────────────────────────────────────────────
SPACETRACK_IDENTITY = os.environ.get('SPACETRACK_IDENTITY', '')
SPACETRACK_PASSWORD = os.environ.get('SPACETRACK_PASSWORD', '')

# ── CORS — allow the Vite dev server (port 5173) to call Django (port 8000) ──
CORS_ALLOWED_ORIGINS = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8000',
]
CORS_ALLOW_CREDENTIALS = True          # needed for session cookies

# ── CSRF trusted origins ─────────────────────────────────────────────────────
CSRF_TRUSTED_ORIGINS = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8000',
]

# ── Auth password validators ─────────────────────────────────────────────────
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# ── Localisation ─────────────────────────────────────────────────────────────
LANGUAGE_CODE = 'en-us'
TIME_ZONE     = 'UTC'
USE_I18N      = True
USE_TZ        = True

# ── Static & media files ─────────────────────────────────────────────────────
# Django serves /static/ in DEBUG mode.
# In production (ElasticBeanstalk) run collectstatic and point nginx to STATIC_ROOT.
STATIC_URL  = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

# The built Vite assets live in dist/ — expose them via Django static serving
STATICFILES_DIRS = [
    BASE_DIR / 'dist',          # Vite production build output
]

# ── Default primary key field type ───────────────────────────────────────────
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
