'use strict';
function runtimeProjectName(project, environment) {
  return environment ? `${project.name} / ${environment.name}` : project.name;
}
module.exports = { runtimeProjectName };
