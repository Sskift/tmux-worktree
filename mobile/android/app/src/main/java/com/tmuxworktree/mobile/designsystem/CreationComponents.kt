@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.tmuxworktree.mobile.designsystem

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.model.RelayProject

@Composable
fun SavedProjectSelector(
    label: String,
    projects: List<RelayProject>,
    selectedProject: RelayProject?,
    placeholder: String,
    enabled: Boolean,
    testTag: String,
    optionTagPrefix: String,
    onSelected: (RelayProject) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectorEnabled = enabled && projects.isNotEmpty()
    val selectionDescription = selectedProject?.let { "${it.name}, ${it.path}" } ?: placeholder

    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = label,
            color = TwTextSecondary,
            style = MaterialTheme.typography.labelMedium,
        )
        Spacer(Modifier.size(6.dp))
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            Surface(
                onClick = { expanded = true },
                enabled = selectorEnabled,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 68.dp)
                    .testTag(testTag)
                    .semantics {
                        role = Role.Button
                        contentDescription = "$label, $selectionDescription"
                        stateDescription = if (expanded) "Expanded" else "Collapsed"
                    },
                shape = RoundedCornerShape(12.dp),
                color = Color.Transparent,
                border = BorderStroke(1.dp, if (expanded) TwAccent else TwBorder),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ProjectIcon(selected = selectedProject != null)
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        if (selectedProject == null) {
                            Text(
                                text = placeholder,
                                color = if (selectorEnabled) TwTextSecondary else TwTextMuted,
                                style = MaterialTheme.typography.bodyLarge,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        } else {
                            Text(
                                text = selectedProject.name,
                                color = TwTextPrimary,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = selectedProject.path,
                                color = TwTextSecondary,
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    Spacer(Modifier.width(10.dp))
                    Icon(
                        imageVector = Icons.Outlined.ExpandMore,
                        contentDescription = null,
                        tint = if (selectorEnabled) TwTextSecondary else TwTextMuted,
                        modifier = Modifier
                            .size(22.dp)
                            .rotate(if (expanded) 180f else 0f),
                    )
                }
            }

            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
                modifier = Modifier
                    .width(maxWidth)
                    .heightIn(max = 360.dp)
                    .background(TwSurfaceRaised)
                    .testTag("${testTag}_menu"),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "SAVED PROJECTS",
                        color = TwTextMuted,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.weight(1f),
                    )
                    Surface(
                        shape = RoundedCornerShape(999.dp),
                        color = TwBorder.copy(alpha = 0.55f),
                    ) {
                        Text(
                            text = projects.size.toString(),
                            color = TwTextSecondary,
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
                HorizontalDivider(color = TwBorder, thickness = 1.dp)

                projects.forEachIndexed { index, project ->
                    val isSelected = selectedProject?.let {
                        it.name == project.name && it.path == project.path
                    } == true
                    DropdownMenuItem(
                        text = {
                            Column(modifier = Modifier.padding(vertical = 3.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = project.name,
                                        color = TwTextPrimary,
                                        style = MaterialTheme.typography.titleMedium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier
                                            .weight(1f)
                                            .testTag("${optionTagPrefix}_${project.name}_name"),
                                    )
                                    project.branch?.takeIf { it.isNotBlank() }?.let { branch ->
                                        Spacer(Modifier.width(8.dp))
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Icon(
                                                imageVector = Icons.Outlined.AccountTree,
                                                contentDescription = null,
                                                tint = TwTextMuted,
                                                modifier = Modifier.size(13.dp),
                                            )
                                            Spacer(Modifier.width(3.dp))
                                            Text(
                                                text = branch,
                                                color = TwTextMuted,
                                                style = MaterialTheme.typography.labelSmall,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                                modifier = Modifier.testTag(
                                                    "${optionTagPrefix}_${project.name}_branch",
                                                ),
                                            )
                                        }
                                    }
                                }
                                Spacer(Modifier.size(2.dp))
                                Text(
                                    text = project.path,
                                    color = TwTextSecondary,
                                    style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.testTag(
                                        "${optionTagPrefix}_${project.name}_path",
                                    ),
                                )
                            }
                        },
                        leadingIcon = { ProjectIcon(selected = isSelected) },
                        trailingIcon = {
                            if (isSelected) {
                                Icon(
                                    imageVector = Icons.Outlined.CheckCircle,
                                    contentDescription = "Selected",
                                    tint = TwAccent,
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                        },
                        onClick = {
                            expanded = false
                            onSelected(project)
                        },
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                        modifier = Modifier
                            .background(if (isSelected) TwAccent.copy(alpha = 0.10f) else Color.Transparent)
                            .testTag("${optionTagPrefix}_${project.name}"),
                    )
                    if (index != projects.lastIndex) {
                        HorizontalDivider(
                            modifier = Modifier.padding(horizontal = 14.dp),
                            color = TwBorder.copy(alpha = 0.65f),
                            thickness = 1.dp,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ProjectIcon(selected: Boolean) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .background(
                color = if (selected) TwAccent.copy(alpha = 0.14f) else TwSurface,
                shape = RoundedCornerShape(10.dp),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Outlined.FolderOpen,
            contentDescription = null,
            tint = if (selected) TwAccent else TwTextSecondary,
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
fun CreationActionBar(
    secondaryLabel: String,
    primaryLabel: String,
    busyLabel: String,
    primaryIcon: ImageVector,
    secondaryEnabled: Boolean,
    primaryEnabled: Boolean,
    isBusy: Boolean,
    secondaryTestTag: String,
    primaryTestTag: String,
    primaryStateDescription: String,
    onSecondary: () -> Unit,
    onPrimary: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(TwSurface)
            .navigationBarsPadding(),
    ) {
        HorizontalDivider(color = TwBorder, thickness = 1.dp)
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp),
        ) {
            val fontScale = LocalDensity.current.fontScale
            val stackActions = maxWidth < 320.dp || fontScale > 1.25f

            if (stackActions) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    CreationSecondaryButton(
                        label = secondaryLabel,
                        enabled = secondaryEnabled,
                        testTag = secondaryTestTag,
                        onClick = onSecondary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    CreationPrimaryButton(
                        label = if (isBusy) busyLabel else primaryLabel,
                        icon = primaryIcon,
                        isBusy = isBusy,
                        enabled = primaryEnabled,
                        testTag = primaryTestTag,
                        stateDescription = primaryStateDescription,
                        onClick = onPrimary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            } else {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CreationSecondaryButton(
                        label = secondaryLabel,
                        enabled = secondaryEnabled,
                        testTag = secondaryTestTag,
                        onClick = onSecondary,
                        modifier = Modifier.weight(0.8f),
                    )
                    CreationPrimaryButton(
                        label = if (isBusy) busyLabel else primaryLabel,
                        icon = primaryIcon,
                        isBusy = isBusy,
                        enabled = primaryEnabled,
                        testTag = primaryTestTag,
                        stateDescription = primaryStateDescription,
                        onClick = onPrimary,
                        modifier = Modifier.weight(1.7f),
                    )
                }
            }
        }
    }
}

@Composable
private fun CreationSecondaryButton(
    label: String,
    enabled: Boolean,
    testTag: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .heightIn(min = 48.dp)
            .testTag(testTag),
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, TwBorder),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = TwTextSecondary),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag("${testTag}_label"),
        )
    }
}

@Composable
private fun CreationPrimaryButton(
    label: String,
    icon: ImageVector,
    isBusy: Boolean,
    enabled: Boolean,
    testTag: String,
    stateDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .heightIn(min = 48.dp)
            .testTag(testTag)
            .semantics { this.stateDescription = stateDescription },
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = TwAccent,
            contentColor = TwOnAccent,
            disabledContainerColor = TwSurfaceRaised,
            disabledContentColor = TwTextMuted,
        ),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
    ) {
        if (isBusy) {
            CircularProgressIndicator(
                color = TwTextSecondary,
                strokeWidth = 2.dp,
                modifier = Modifier.size(18.dp),
            )
        } else {
            Icon(
                imageVector = icon,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
            )
        }
        Spacer(Modifier.width(6.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag("${testTag}_label"),
        )
    }
}
