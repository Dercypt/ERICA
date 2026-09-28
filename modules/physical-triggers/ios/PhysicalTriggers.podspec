Pod::Spec.new do |s|
  s.name           = 'PhysicalTriggers'
  s.version        = '0.1.0'
  s.summary        = 'Hardware and sensor panic triggers for ERICA'
  s.description    = 'Native volume button pattern detector and high-pass shake detector for ERICA'
  s.author         = 'ERICA Team'
  s.homepage       = 'https://github.com/justsayp25/ERICA'
  s.platform       = :ios, '15.1'
  s.source         = { :git => '' }
  s.source_files   = '**/*.{h,m,mm,swift,hpp,cpp}'
  s.dependency 'ExpoModulesCore'
end
