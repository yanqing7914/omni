package com.omnifarious.omniagent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** `appLaunch` 的包名判据：只放行标准 Android 包名形状。 */
class AppLaunchPolicyTest {

  @Test
  fun acceptsOrdinaryPackageNames() {
    assertTrue(AppLaunchPolicy.isValidPackage("com.taobao.taobao"))
    assertTrue(AppLaunchPolicy.isValidPackage("com.tmall.wireless"))
    assertTrue(AppLaunchPolicy.isValidPackage("a"))
    assertTrue(AppLaunchPolicy.isValidPackage("com.example.app_2"))
  }

  @Test
  fun rejectsShellMetacharactersAndEmptyValues() {
    assertFalse(AppLaunchPolicy.isValidPackage(null))
    assertFalse(AppLaunchPolicy.isValidPackage(""))
    assertFalse(AppLaunchPolicy.isValidPackage("com.example app"))
    assertFalse(AppLaunchPolicy.isValidPackage("com.example;rm -rf /"))
    assertFalse(AppLaunchPolicy.isValidPackage("1com.example"))
    assertFalse(AppLaunchPolicy.isValidPackage("com..example"))
    assertFalse(AppLaunchPolicy.isValidPackage("com.example/app"))
  }
}
