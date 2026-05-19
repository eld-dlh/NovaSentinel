"""
NovaSentinel — root URL configuration.

Public routes:
    /              → dashboard (Three.js globe served as a Django template)
    /api/          → REST proxy views (TLE, CDM, OMM, audit log)
    /admin/        → Django admin interface
"""

from django.contrib import admin
from django.urls     import path, include
from django.conf     import settings
from django.conf.urls.static import static

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/',   include('dashboard.urls')),
    path('',       include('dashboard.urls')),  # dashboard root at /
]

# Serve static & media in DEBUG mode (Vite dist/ is exposed as /static/)
if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
