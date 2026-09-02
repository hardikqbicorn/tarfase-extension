plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij") version "1.17.4"
    kotlin("plugin.serialization") version "1.9.25"
}

group = "com.idecollector"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
}

// Targets the IntelliJ Platform, so the same plugin installs into IDEA,
// PyCharm, GoLand, WebStorm, RubyMine, CLion, Rider, and Android Studio.
intellij {
    version.set("2024.1")
    type.set("IC")
    plugins.set(listOf("Git4Idea"))
}

kotlin {
    jvmToolchain(17)
}

tasks {
    patchPluginXml {
        sinceBuild.set("241")
        untilBuild.set("251.*")
    }

    test {
        useJUnitPlatform()
    }
}
