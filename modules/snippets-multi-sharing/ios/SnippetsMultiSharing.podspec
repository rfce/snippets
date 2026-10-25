require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'SnippetsMultiSharing'
  s.version        = package['version']
  s.summary        = 'Multiple image sharing for Snippets'
  s.description    = 'Shares multiple selected snippets through the native share sheet.'
  s.license        = { :type => 'MIT' }
  s.author         = { 'Snippets' => 'snippets@example.com' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://example.com/snippets-multi-sharing.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
