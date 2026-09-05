# Instagram: focused JVM contract tests

This isolated Gradle project compiles the actual platform-independent native Instagram
models, validation rules, HTTP client, publication-intent policies and UI state.
It uses synthetic fixtures and a loopback-only MockWebServer. No official login,
Instagram OAuth, upload, publication or external service is exercised.

Run with JDK 17 and Gradle 8.9:

```powershell
gradle --no-daemon --console=plain test
```

Passing these tests does **not** prove that Compose compiles, an APK is signed or
installed, production has the social endpoints enabled, or the Meta review flow
is ready. Full Android build and authorized end-to-end validation remain separate.
