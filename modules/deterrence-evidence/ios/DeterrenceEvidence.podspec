Pod::Spec.new do |s|
  s.name           = 'DeterrenceEvidence'
  s.version        = '0.1.0'
  s.summary        = 'Native deterrence and evidence capture module for ERICA'
  s.description    = 'Provides off-thread siren, camera strobe, and consent-gated evidence capture for ERICA'
  s.author         = 'E.R.I.C.A. Contributors'
  s.homepage       = 'https://github.com/justsayp25/ERICA'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.source_files   = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'AVFoundation'
  s.swift_version  = '5.4'
end
