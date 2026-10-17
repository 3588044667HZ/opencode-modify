plugins {
  id("org.jetbrains.intellij.platform") version "2.2.1"
}

repositories {
  mavenCentral()
  intellijPlatform {
    defaultRepositories()
  }
}

// IDE 位置来自环境变量（与 Launcher / script/resolve-env.sh 同优先级）：
// SEMANTIC_IDE_HOME > IDEA_HOME > IDEA_DIR；gradle-build.sh 会自动发现并导出，亦可手工指定。
// 只使用本机安装的 IDE，不做任何下载。
dependencies {
  intellijPlatform {
    local(
      providers.environmentVariable("SEMANTIC_IDE_HOME")
        .orElse(providers.environmentVariable("IDEA_HOME"))
        .orElse(providers.environmentVariable("IDEA_DIR"))
    )
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
  // IDEA 2026.2 平台类文件是 Java 25 (class file 69)，低版本 javac 读不了；
  // 而 Gradle 8.5 自身不能运行在 Java 25 上，因此保持 Gradle 运行在 ≤21、
  // fork 独立的编译 JDK：SEMANTIC_JDK_HOME > JAVA_HOME（缺省沿用当前 Gradle JVM）。
  val compileJdk = providers.environmentVariable("SEMANTIC_JDK_HOME")
    .orElse(providers.environmentVariable("JAVA_HOME"))
    .orNull
  options.isFork = true
  if (compileJdk != null) options.forkOptions.javaHome = file(compileJdk)
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
