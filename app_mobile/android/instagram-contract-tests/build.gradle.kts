plugins {
    kotlin("jvm") version "2.0.21"
}

kotlin { jvmToolchain(17) }

// Compile the actual platform-independent feature sources. This is not an Android build.
sourceSets {
    main {
        kotlin.srcDir("../app/src/main/java")
        kotlin.include(
            "br/com/ia4tube/app/feature/instagram/InstagramModels.kt",
            "br/com/ia4tube/app/feature/instagram/InstagramPolicies.kt",
            "br/com/ia4tube/app/feature/instagram/InstagramApiClient.kt",
            "br/com/ia4tube/app/feature/instagram/InstagramPublicationIntentStore.kt",
            "br/com/ia4tube/app/feature/instagram/InstagramUiState.kt"
        )
    }
    test {
        kotlin.srcDir("../app/src/test/java")
        kotlin.include("br/com/ia4tube/app/feature/instagram/**")
        // Actual Android ViewModel tests run via :app:testDebugUnitTest with the SDK.
        kotlin.exclude("br/com/ia4tube/app/feature/instagram/InstagramViewModelTest.kt")
    }
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

tasks.test {
    useJUnit()
    testLogging { events("passed", "skipped", "failed") }
}
