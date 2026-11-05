package com.omnifarious.omniagent

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Real Android regression over the retirement transformer and failed profile publication. */
class FactoryRetirementSafetyTest {
  @Test fun unrelatedUnnamedEntriesSurviveAndFailedPublicationPreservesOldProfile() {
    val input = "- id: ordinary-row\n  disabled: false\n- id: user-row\n  config:\n    value: keep-exactly\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n"
    val result = FactoryProfilePatch.repairRetiredEntries(input, emptySet(), FactoryProfilePatch.RETIRED_FACTORY_ENTRIES)
    assertTrue("ordinary unnamed row without config must survive retirement", result.text.contains("- id: ordinary-row\n  disabled: false\n"))
    assertTrue("ordinary configured row must survive retirement", result.text.contains("- id: user-row\n  config:\n    value: keep-exactly\n"))
    assertFalse("unconfigured factory undo must be retired", result.text.contains("- id: dsh-undo-savepoint"))
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "factory-retirement-" + System.nanoTime()).apply { mkdirs() }
    val target = File(root, "cordis.patch.yml").apply { writeText(input) }
    val oldBytes = target.readBytes()
    try {
      try {
        SnapshotTransaction.writeTextAtomic(target, result.text, "retirement test", publish = { _, _ -> false }) { }
        throw AssertionError("publication failure must propagate")
      } catch (_: SnapshotFsException) {
        assertTrue("failed retirement publication must keep exact old bytes", target.readBytes().contentEquals(oldBytes))
      }
      SnapshotTransaction.writeTextAtomic(target, result.text, "retirement test") { }
      assertEquals(result.text, target.readText())
    } finally {
      SnapshotFs.deletePath(root)
    }
  }
}
