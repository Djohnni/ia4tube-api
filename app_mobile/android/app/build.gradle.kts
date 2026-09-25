import java.util.Properties
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.gms.google-services")
}

val googleServicesFile = layout.projectDirectory.file("google-services.json").asFile
if (!googleServicesFile.isFile) {
    throw org.gradle.api.GradleException(
        "Missing app/google-services.json. Firebase/FCM builds must include this file."
    )
}

val uploadStorePassword = providers.gradleProperty("IA4TUBE_UPLOAD_STORE_PASSWORD")
    .orElse(providers.environmentVariable("IA4TUBE_UPLOAD_STORE_PASSWORD"))
val uploadKeyPassword = providers.gradleProperty("IA4TUBE_UPLOAD_KEY_PASSWORD")
    .orElse(providers.environmentVariable("IA4TUBE_UPLOAD_KEY_PASSWORD"))
    .orElse(uploadStorePassword)

val productionApiBase = "https://ia4tube-api.onrender.com"
val explicitDebugProductDiscoveryApiBase = providers
    .gradleProperty("IA4TUBE_PRODUCT_DISCOVERY_API_BASE")
    .orNull
    ?.trim()
    ?.trimEnd('/')
    ?.takeIf { it.isNotBlank() }
val debugProductDiscoveryApiBase = explicitDebugProductDiscoveryApiBase ?: productionApiBase
val localIsolatedTests = providers.gradleProperty("ia4tubeLocalIsolatedTests")
    .map { it.toBooleanStrict() }.getOrElse(false)
val localUiResourceTests = providers.gradleProperty("ia4tubeLocalUiResources")
    .map { it.toBooleanStrict() }.getOrElse(false)
check(!(localIsolatedTests && localUiResourceTests)) {
    "Run navigation isolation and resource-backed UI proofs separately."
}

fun String.asBuildConfigString(): String {
    return "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}

android {
    namespace = "br.com.ia4tube.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.ia4tube.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 59
        versionName = "0.2.46"

        buildConfigField("String", "API_BASE", productionApiBase.asBuildConfigString())
        buildConfigField("String", "PRODUCT_DISCOVERY_API_BASE", productionApiBase.asBuildConfigString())
        buildConfigField("boolean", "MEDIA_IMPORT_ENTRY_POINTS_VISIBLE", "true")
    }

    signingConfigs {
        create("release") {
            storeFile = file("C:/IA4TubeKeys/upload-keystore.jks")
            storePassword = uploadStorePassword.orNull
            keyAlias = "ia4tube"
            keyPassword = uploadKeyPassword.orNull
        }
    }

    buildTypes {
        debug {
            buildConfigField(
                "String",
                "PRODUCT_DISCOVERY_API_BASE",
                debugProductDiscoveryApiBase.asBuildConfigString()
            )
            manifestPlaceholders["productDiscoveryUsesCleartext"] =
                debugProductDiscoveryApiBase.startsWith("http://").toString()
        }
        release {
            buildConfigField(
                "String",
                "PRODUCT_DISCOVERY_API_BASE",
                productionApiBase.asBuildConfigString()
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        // Explicit local proof mode excludes the real manifest/providers. Default app builds are unchanged.
        unitTests.isIncludeAndroidResources = !localIsolatedTests
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// Explicit JVM-test fixture only. Normal builds and every product manifest/artifact are untouched.
// Robolectric parses the binary APK manifest even when @Config(manifest = NONE) is used:
// replacing only the text manifest would still initialize product providers.
if (localUiResourceTests) {
    val agpConfigDir = layout.buildDirectory.dir(
        "intermediates/unit_test_config_directory/debugUnitTest/generateDebugUnitTestConfig/out")
    val agpConfig = agpConfigDir.map { it.file("com/android/tools/test_config.properties") }
    val fixtureDir = layout.buildDirectory.dir("local-ui-resource-fixture")
    val fixtureClasspath = fixtureDir.map { it.dir("classpath") }
    val syntheticManifest = layout.projectDirectory.file("src/test/fixtures/ui-resources/AndroidManifest.xml")
    val aapt2 = android.sdkDirectory.resolve("build-tools/${android.buildToolsVersion}/aapt2" +
        if (System.getProperty("os.name").startsWith("Windows")) ".exe" else "")
    val framework = android.sdkDirectory.resolve("platforms/android-${android.compileSdk}/android.jar")
    val makeUiFixture = tasks.register("prepareLocalUiResourceFixture") {
        dependsOn("generateDebugUnitTestConfig", "packageDebugUnitTestForUnitTest")
        inputs.file(syntheticManifest)
        inputs.file(agpConfig)
        inputs.file(layout.buildDirectory.file(
            "intermediates/apk_for_local_test/debugUnitTest/packageDebugUnitTestForUnitTest/apk-for-local-test.ap_"))
        outputs.dir(fixtureDir)
        doLast {
            check(aapt2.isFile && framework.isFile) { "Local Android build tools must already be installed." }
            val properties = Properties().apply { agpConfig.get().asFile.inputStream().use { load(it) } }
            val resourceApk = file(properties.getProperty("android_resource_apk"))
            check(resourceApk.isFile) { "AGP test resource APK is missing." }
            val output = fixtureDir.get().asFile.apply { mkdirs() }
            val manifestApk = output.resolve("synthetic-manifest.ap_")
            project.exec {
                commandLine(aapt2.absolutePath, "link", "--manifest", syntheticManifest.asFile.absolutePath,
                    "-I", framework.absolutePath, "-o", manifestApk.absolutePath)
            }.assertNormalExitValue()
            val fixtureApk = output.resolve("resources-only.ap_")
            ZipFile(resourceApk).use { original ->
                ZipFile(manifestApk).use { manifest ->
                    ZipOutputStream(fixtureApk.outputStream().buffered()).use { destination ->
                        fun copyEntry(zip: ZipFile, entry: ZipEntry) {
                            check(!entry.name.startsWith('/') && !entry.name.split('/').contains(".."))
                            val copied = ZipEntry(entry.name).apply {
                                time = 0L
                                method = entry.method
                                if (entry.method == ZipEntry.STORED) {
                                    size = entry.size; compressedSize = entry.size; crc = entry.crc
                                }
                            }
                            destination.putNextEntry(copied)
                            zip.getInputStream(entry).use { it.copyTo(destination) }
                            destination.closeEntry()
                        }
                        copyEntry(manifest, checkNotNull(manifest.getEntry("AndroidManifest.xml")))
                        checkNotNull(original.getEntry("resources.arsc"))
                        original.entries().asSequence().filter {
                            !it.isDirectory && (it.name == "resources.arsc" || it.name.startsWith("res/"))
                        }.forEach { copyEntry(original, it) }
                    }
                }
            }
            val emptyAssets = output.resolve("empty-assets").apply { mkdirs() }
            val fixtureConfig = fixtureClasspath.get().asFile.resolve("com/android/tools/test_config.properties")
            fixtureConfig.parentFile.mkdirs()
            Properties().apply {
                setProperty("android_merged_manifest", syntheticManifest.asFile.absolutePath)
                setProperty("android_resource_apk", fixtureApk.absolutePath)
                setProperty("android_merged_assets", emptyAssets.absolutePath)
                setProperty("android_custom_package", "br.com.ia4tube.app")
                fixtureConfig.outputStream().use { store(it, "Local UI-only synthetic manifest and resource bytes; no product code") }
            }
        }
    }
    tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
        if (name == "testDebugUnitTest") {
            dependsOn(makeUiFixture)
            systemProperty("ia4tube.localUiResources", "true")
            inputs.property("ia4tubeLocalUiResources", true)
            inputs.dir(fixtureDir)
            // AGP finalizes the test classpath after plugin configuration, so replace its
            // generated config at execution time, before starting the test JVM.
            doFirst {
                val configRoot = agpConfigDir.get().asFile.canonicalFile
                val currentClasspath = classpath.files
                check(currentClasspath.count { it.canonicalFile == configRoot } == 1) {
                    "Expected exactly one AGP test configuration directory; refusing ambiguous fixture setup."
                }
                classpath = files(fixtureClasspath) + files(currentClasspath.filter { it.canonicalFile != configRoot })
            }
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    val firebaseBom = platform("com.google.firebase:firebase-bom:33.7.0")

    implementation(composeBom)
    implementation(firebaseBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.3")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.google.android.play:app-update:2.1.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
