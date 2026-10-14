plugins {
  id("org.jetbrains.intellij.platform") version "2.2.1"
}

repositories {
  mavenCentral()
  intellijPlatform {
    defaultRepositories()
  }
}

dependencies {
  intellijPlatform {
    // 本机 IDEA 2026.2.0.1，避免任何下载
    local("D:/IntelliJ IDEA 2026.2.0.1")
    bundledPlugin("com.intellij.java")
  }
}

java {
  sourceCompatibility = JavaVersion.VERSION_21
  targetCompatibility = JavaVersion.VERSION_21
}

tasks.withType<JavaCompile>().configureEach {
  options.encoding = "UTF-8"
  options.release.set(21)
  // IDEA 2026.2 平台类文件是 Java 25 (class file 69)，JDK 21 的 javac 无法读取；
  // 而 Gradle 8.5 自身不能运行在 Java 25 上，因此保持 Gradle 运行在 JBR 21、
  // fork JDK 25 的 javac 来编译（与 script/build-local.sh 一致）。
  options.isFork = true
  options.forkOptions.javaHome = file("D:/jdk25")
}

intellijPlatform {
  pluginConfiguration {
    id = "opencode.semantic"
    name = "OpenCode Semantic Server"
    version = "0.1.0"
    vendor {
      name = "opencode"
    }
  }
}

tasks {
  patchPluginXml {
    sinceBuild.set("262")
    untilBuild.set("262.*")
  }
  // 无头构建环境跑不了 searchable options 索引（需拉起 IDE），服务端插件不需要
  named("buildSearchableOptions") {
    enabled = false
  }
}
